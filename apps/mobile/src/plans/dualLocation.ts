import { applyCalibration } from "@ff/data/calibration/similarity";
import { UNCALIBRATED_CALIB_ID, type CalibrationTransformParams } from "@ff/types";
import { LINKVIEW_ORIGIN } from "@ff/tasks";
import type { CalibrationLike } from "@ff/tasks-react";
import type { TaskLocation } from "@ff/firestore";

/** Height of the 3D point above the storey floor (m): the same nominal height the Link view draws plan-only pins at. */
export const POINT_HEIGHT = 1.2;

export interface DualInput {
  /** the calibration of the plan (null / the uncalibrated sentinel: no 3D point) */
  calibration: Pick<CalibrationLike, "id" | "transformParams"> | null;
  /** page size in PDF points, the unit the calibration works in */
  page: { width: number; height: number } | null;
  /** elevation of the calibrated storey's floor (m); null when the building has no such storey */
  floorY: number | null;
}

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/**
 * The 3D point under a plan pin: the pin's page position through the calibration, at `floorY + POINT_HEIGHT`. Null when the
 * plan is not calibrated (or the calibration is unusable), the page size or floor is unknown, or the pin is off the page.
 * Calibrations belong to page 1.
 */
export function worldPointForPin(pdf: { page: number; uv: [number, number] }, input: DualInput): [number, number, number] | null {
  const { calibration: c, page, floorY } = input;
  if (!c || c.id === UNCALIBRATED_CALIB_ID || pdf.page !== 1 || !page || floorY === null) return null;
  if (!(page.width > 0) || !(page.height > 0) || !finite(floorY)) return null;
  const p = c.transformParams as CalibrationTransformParams | undefined;
  if (!p || !(p.scale > 0) || ![p.rotation, p.translateX, p.translateZ].every(finite)) return null;
  const [u, v] = pdf.uv;
  if (!finite(u) || !finite(v) || u < 0 || u > 1 || v < 0 || v > 1) return null;
  const w = applyCalibration(p, { x: u * page.width, y: v * page.height });
  if (!finite(w.x) || !finite(w.z)) return null;
  return [w.x, floorY + POINT_HEIGHT, w.z];
}

/**
 * A plan pin's location with its matching 3D point, in the shape the web stores for dual-location tasks: `pdf` and `bim`
 * (no elements, a world point, no camera) together with `origin: "linkview"`. A location that is not a plan pin, or a plan that
 * cannot place the point, comes back untouched (the task is an ordinary plan task, as before).
 */
export function withModelPoint(loc: TaskLocation, input: DualInput): TaskLocation {
  if (!loc.pdf || loc.bim) return loc;
  const point = worldPointForPin(loc.pdf, input);
  if (!point) return loc;
  return { ...loc, origin: LINKVIEW_ORIGIN, bim: { elements: [], worldPoint: point, cameraPose: null } };
}
