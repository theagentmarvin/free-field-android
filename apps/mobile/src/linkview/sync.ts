/**
 * Pure maths of the Link view: plan page points <-> world, and the walker's heading <-> the marker's heading on the page.
 * The calibration transform is the web's own (`@ff/data/calibration/similarity`, world = scale * R(rotation) * page + t,
 * page y down). The bearing helpers mirror the web LinkView's `linkviewNav.ts` (bearing = atan2(dz, dx), the marker cone is
 * drawn at bearing - rotation) so a calibration behaves the same on the web and on the tablet.
 *
 * Two heading conventions meet here:
 *  - the 3D walker's `yaw`: 0 looks along -Z, positive turns right (clockwise seen from above);
 *  - the web `bearing`: atan2(dz, dx), 0 looks along +X, positive turns toward +Z (also clockwise seen from above).
 * They differ by a quarter turn: bearing = yaw - PI/2.
 */
import { applyCalibration, invertCalibration } from "@ff/data/calibration/similarity";
import type { CalibrationRecord, CalibrationTransformParams } from "@ff/types";
import type { LinkWalker } from "./binding";

export interface PagePt {
  x: number;
  y: number;
}
export interface PageSize {
  width: number;
  height: number;
}
/** Where the marker stands on the plan page and which way it looks (`heading`: radians on the y-down page, 0 = +x, clockwise positive). */
export interface PlanMarker {
  page: PagePt;
  heading: number;
}

const TAU = Math.PI * 2;
/** Wrap to (-PI, PI]. */
export function wrapAngle(a: number): number {
  const r = ((((a + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
  return r === -Math.PI ? Math.PI : r;
}

export const bearingFromYaw = (yaw: number): number => yaw - Math.PI / 2;
export const yawFromBearing = (bearing: number): number => bearing + Math.PI / 2;

/** Walker heading -> marker heading on the page. */
export function pageHeadingFromYaw(params: CalibrationTransformParams, yaw: number): number {
  return wrapAngle(bearingFromYaw(yaw) - params.rotation);
}
/** Marker heading on the page -> walker yaw. */
export function yawFromPageHeading(params: CalibrationTransformParams, heading: number): number {
  return wrapAngle(yawFromBearing(heading + params.rotation));
}

export const worldFromPage = (params: CalibrationTransformParams, p: PagePt): { x: number; z: number } => applyCalibration(params, p);
export function pageFromWorld(params: CalibrationTransformParams, w: { x: number; z: number }): PagePt {
  const p = invertCalibration(params, w);
  return { x: p.x, y: p.y };
}

export const insidePage = (p: PagePt, page: PageSize, margin = 0): boolean => p.x >= -margin && p.y >= -margin && p.x <= page.width + margin && p.y <= page.height + margin;

export function clampToPage(p: PagePt, page: PageSize): PagePt {
  return { x: Math.min(Math.max(p.x, 0), page.width), y: Math.min(Math.max(p.y, 0), page.height) };
}

/** The walker for a plan tap / marker: the world point under the page point, at `floorY`, looking along the page heading. */
export function walkerFromPage(params: CalibrationTransformParams, floorY: number, p: PagePt, heading: number): LinkWalker {
  const w = worldFromPage(params, p);
  return { x: w.x, z: w.z, floorY, yaw: yawFromPageHeading(params, heading) };
}

/** The marker for a walker. */
export function markerFromWalker(params: CalibrationTransformParams, w: Pick<LinkWalker, "x" | "z" | "yaw">): PlanMarker {
  return { page: pageFromWorld(params, w), heading: pageHeadingFromYaw(params, w.yaw) };
}

/**
 * Where the Link view starts when nothing says otherwise: the calibration's first anchor (a point known to be on the sheet),
 * looking toward its second anchor (also on the sheet), at `floorY`. Needs no page size, so the 3D pane can start at once.
 */
export function seedWalker(record: Pick<CalibrationRecord, "pointPairs">, floorY: number): LinkWalker {
  const [a, b] = record.pointPairs;
  const ok = (p: { worldX: number; worldZ: number } | undefined): p is { worldX: number; worldZ: number } => !!p && Number.isFinite(p.worldX) && Number.isFinite(p.worldZ);
  if (!ok(a)) return { x: 0, z: 0, floorY, yaw: 0 };
  const apart = ok(b) && Math.hypot(b.worldX - a.worldX, b.worldZ - a.worldZ) > 0.01;
  return { x: a.worldX, z: a.worldZ, floorY, yaw: apart ? yawFromBearing(Math.atan2(b.worldZ - a.worldZ, b.worldX - a.worldX)) : 0 };
}

/** Sub-centimetre or sub-half-degree changes are noise: skip them so the marker does not re-render for nothing. */
export function walkerChanged(a: LinkWalker | null, b: LinkWalker, posEps = 0.02, yawEps = (0.5 * Math.PI) / 180): boolean {
  if (!a) return true;
  return Math.hypot(a.x - b.x, a.z - b.z) > posEps || Math.abs(a.floorY - b.floorY) > 1e-6 || Math.abs(wrapAngle(a.yaw - b.yaw)) > yawEps;
}
