import type { CalibrationRecord, PdfFileRecord, StoreyRecord } from "@ff/types";
import { extractPdfPins, extractPins, type LocatablePdfTask, type LocatableTask, type PanelTask, type TaskPin } from "@ff/tasks-react";
import type { PlanPin } from "../plans/pins";
import { uvInPage } from "../plans/viewMath";
import { pageFromWorld, worldFromPage, insidePage, type PageSize } from "./sync";
import { storeyChips } from "../model/storeys";
import { walkLevels, type WalkLevel } from "../model/walkLevels";

/** One plan that can be linked to the model: a PDF calibrated on a storey of its building. */
export interface CalibratedPlan {
  pdfFileId: string;
  name: string;
  storeyName: string;
  calibration: CalibrationRecord;
}

const validScale = (c: CalibrationRecord) => Number.isFinite(c.transformParams?.scale) && c.transformParams.scale > 0;

/**
 * The plans of a building that carry a usable calibration, one per (plan, storey): the newest calibration row of the project wins.
 * A calibration whose storey does not exist in the building is ignored (nothing to stand on).
 */
export function calibratedPlans(input: { files: readonly Pick<PdfFileRecord, "id" | "name" | "buildingId">[]; calibrations: readonly CalibrationRecord[]; storeys: readonly Pick<StoreyRecord, "name">[]; projectId: string; buildingId: string }): CalibratedPlan[] {
  const names = new Set(input.storeys.map((s) => s.name));
  const files = new Map(input.files.filter((f) => f.buildingId === input.buildingId).map((f) => [f.id, f]));
  const best = new Map<string, CalibratedPlan>();
  for (const c of input.calibrations) {
    const f = files.get(c.pdfFileId);
    if (!f || c.projectId !== input.projectId || !validScale(c) || !names.has(c.storeyName)) continue;
    const key = `${c.pdfFileId}\u0000${c.storeyName}`;
    const prev = best.get(key);
    if (!prev || c.updatedAt > prev.calibration.updatedAt) best.set(key, { pdfFileId: c.pdfFileId, name: f.name, storeyName: c.storeyName, calibration: c });
  }
  return [...best.values()];
}

/** Calibrated plans ordered by storey elevation (lowest first), then name. */
export function sortPlans(plans: readonly CalibratedPlan[], levels: readonly WalkLevel[]): CalibratedPlan[] {
  const el = new Map(levels.map((l) => [l.name, l.elevation]));
  return [...plans].sort((a, b) => (el.get(a.storeyName) ?? 0) - (el.get(b.storeyName) ?? 0) || a.storeyName.localeCompare(b.storeyName) || a.name.localeCompare(b.name));
}

/** The plan to show for a request: the exact (plan, storey), else the plan (its first storey), else the storey's first plan, else the first plan. */
export function choosePlan(plans: readonly CalibratedPlan[], want: { plan?: string | null; storey?: string | null }): CalibratedPlan | null {
  if (plans.length === 0) return null;
  const byPlan = want.plan ? plans.filter((p) => p.pdfFileId === want.plan) : [];
  const exact = byPlan.find((p) => p.storeyName === want.storey);
  if (exact) return exact;
  if (byPlan.length > 0 && !want.storey) return byPlan[0];
  const byStorey = want.storey ? plans.find((p) => p.storeyName === want.storey) : undefined;
  return byStorey ?? byPlan[0] ?? plans[0];
}

/** Plans of one storey. */
export const plansForStorey = (plans: readonly CalibratedPlan[], storeyName: string): CalibratedPlan[] => plans.filter((p) => p.storeyName === storeyName);

/** Level of a storey name, from the building's storey rows (lowest elevation per name, as the walk level picker does). */
export function levelOf(storeys: readonly StoreyRecord[], name: string): WalkLevel | null {
  return walkLevels(storeyChips(storeys)).find((l) => l.name === name) ?? null;
}

/** The storey band [floor, ceiling) of a level: up to the next level, else a nominal 4 m. */
export function storeyBand(levels: readonly WalkLevel[], floorY: number): { lo: number; hi: number } {
  const above = levels.map((l) => l.elevation).filter((e) => e > floorY + 0.05).sort((a, b) => a - b)[0];
  return { lo: floorY - 0.3, hi: above !== undefined ? above - 0.3 : floorY + 4 };
}

/** Height of a pin marker above the floor when the task only has a plan position. */
export const PIN_HEIGHT = 1.2;

/**
 * Task pins for the plan pane: every task with a 3D point inside this plan's page and storey band is drawn at the point's page position.
 * Tasks that already carry a plan position on this plan are drawn by the plan's own pin source, so they are skipped here.
 */
export function planPinsFromModel(tasks: readonly PanelTask[], opts: { calibration: CalibrationRecord; page: PageSize; floorY: number; levels: readonly WalkLevel[]; buildingId: string; pdfFileId: string; versionId: string }): PlanPin[] {
  const band = storeyBand(opts.levels, opts.floorY);
  const own = new Set(extractPdfPins(tasks as unknown as LocatablePdfTask[]).filter((p) => p.pdfFileId === opts.pdfFileId).map((p) => p.taskId));
  const pending = new Set(tasks.filter((t) => t.pending).map((t) => t.id));
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const out: PlanPin[] = [];
  for (const p of extractPins(tasks as unknown as LocatableTask[])) {
    if (own.has(p.taskId)) continue;
    const t = byId.get(p.taskId);
    if (t?.buildingId && t.buildingId !== opts.buildingId) continue;
    const [x, y, z] = p.worldPoint;
    if (![x, y, z].every(Number.isFinite) || y < band.lo || y >= band.hi) continue;
    const pg = pageFromWorld(opts.calibration.transformParams, { x, z });
    if (!insidePage(pg, opts.page)) continue;
    const uv: [number, number] = [pg.x / opts.page.width, pg.y / opts.page.height];
    if (!uvInPage(uv)) continue;
    out.push({ taskId: p.taskId, num: p.num, title: p.title, status: p.status, pending: pending.has(p.taskId), uv, pdfVersionId: opts.versionId, onEarlierRevision: false, revision: { kind: "current" } });
  }
  return out;
}

/**
 * Task pins for the 3D pane from tasks that only have a plan position on this plan (their 3D point is the calibrated page point,
 * at a nominal pin height above the storey floor). Tasks that already have a 3D point are drawn by the model's own pin source.
 */
export function modelPinsFromPlan(planPins: readonly PlanPin[], opts: { calibration: CalibrationRecord; page: PageSize; floorY: number; buildingId: string }, alreadyInModel: ReadonlySet<string>): TaskPin[] {
  const out: TaskPin[] = [];
  for (const p of planPins) {
    if (alreadyInModel.has(p.taskId) || p.revision.kind === "earlier") continue; // a pin of an older revision may sit elsewhere on the new drawing; legacy pins (no revision recorded) are shown
    const w = worldFromPage(opts.calibration.transformParams, { x: p.uv[0] * opts.page.width, y: p.uv[1] * opts.page.height });
    out.push({ taskId: p.taskId, num: p.num, title: p.title, status: p.status, pending: p.pending, worldPoint: [w.x, opts.floorY + PIN_HEIGHT, w.z], cameraPose: null, elements: [], buildingId: opts.buildingId });
  }
  return out;
}
