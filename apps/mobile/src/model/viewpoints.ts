/**
 * Saved viewpoints of the Model tab. Same data path as the web: rows of the shared `viewerViewpoints` Dexie table
 * (`ViewerViewpointRecord`, `blob` = JSON of a `ViewerViewpointSnapshot`). The sync engine's write hooks queue every
 * create / rename / delete, so this module never talks to the network and works offline.
 *
 * The blob keeps the web's fields (`pose`, `sectionPlanes`, `visibility`) so the web can restore the camera, the cuts and
 * the hidden/isolated elements of a view saved here, and adds one optional `mobile` block (ignored by the web decoder)
 * with what only this app has: the building, the level filter and its cut, hidden models and categories, the section
 * box / axis planes as edited, x-ray. A web view (no `mobile` block) is shown in every building and restored from its fields.
 */
import { useLiveQuery } from "dexie-react-hooks";
import { db as appDb, type ProjectDatabase } from "@ff/data/db/database";
import type { ViewerViewpointPose, ViewerViewpointRecord, ViewerViewpointSnapshot, ViewpointSectionPlane, ViewpointVisibility } from "@ff/types";
import { axisIndex, AXES, sectionPlanes, type Axis, type AxisPlane, type PlaneData, type SectionState } from "./sectionBox";
import type { IdSets, VisState } from "./visibility";
import type { Box, Vec3 } from "./viewMath";

export type ViewpointDb = Pick<ProjectDatabase, "viewerViewpoints">;

/** Same cap as the web (per project there; per building here, so one building's views never evict another's). */
export const MAX_VIEWS_PER_BUILDING = 12;
export const MAX_NAME = 60;

type IdList = Array<{ modelId: string; ids: number[] }>;

/** What only the mobile app saves (see the file comment). */
export interface MobileViewExt {
  v: 1;
  buildingId: string;
  level: string | null;
  cut: boolean;
  section: { box: Box | null; planes: AxisPlane[] };
  hiddenModels: string[];
  hiddenCategories: string[];
  hiddenIds: IdList;
  forced: IdList;
  isolated: IdList | null;
  solid: IdList | null;
}

export type ViewBlob = ViewerViewpointSnapshot & { mobile?: MobileViewExt };

/** The part of the model state a view captures. */
export interface ViewState {
  pose: ViewerViewpointPose | null;
  section: SectionState;
  secBounds: Box | null;
  vis: VisState;
  level: string | null;
  cut: boolean;
  buildingId: string;
}

const listOf = (s: IdSets): IdList => [...s].filter(([, ids]) => ids.size > 0).map(([modelId, ids]) => ({ modelId, ids: [...ids] }));
const setsOf = (l: IdList | null | undefined): Map<string, Set<number>> => new Map((l ?? []).map((e) => [e.modelId, new Set(e.ids)]));

/** The web's visibility slice of a state: hidden ids and the isolation (a level filter is not an isolation: it travels as `level`). */
export function webVisibility(vis: VisState): ViewpointVisibility | null {
  const hidden = listOf(vis.hiddenIds);
  const isolate = vis.isolated ? { visible: listOf(vis.isolated) } : null;
  return hidden.length === 0 && isolate === null ? null : { hidden, isolate };
}

export function captureView(s: ViewState): ViewBlob {
  const planes = s.secBounds ? sectionPlanes(s.section, s.secBounds) : [];
  return {
    pose: s.pose ? { pos: [...s.pose.pos], target: [...s.pose.target], fov: s.pose.fov, isOrtho: s.pose.isOrtho } : null,
    sectionPlanes: planes.map((p) => ({ point: { ...p.point }, normal: { ...p.normal } })),
    visibility: webVisibility(s.vis),
    mobile: {
      v: 1,
      buildingId: s.buildingId,
      level: s.level,
      cut: s.cut && s.level !== null,
      section: { box: s.section.box ? { min: [...s.section.box.min], max: [...s.section.box.max] } : null, planes: s.section.planes.map((p) => ({ ...p })) },
      hiddenModels: [...s.vis.hiddenModels],
      hiddenCategories: [...s.vis.hiddenCategories],
      hiddenIds: listOf(s.vis.hiddenIds),
      forced: listOf(s.vis.forced),
      isolated: s.vis.isolated ? listOf(s.vis.isolated) : null,
      solid: s.vis.solid ? listOf(s.vis.solid) : null,
    },
  };
}

export const encodeView = (b: ViewBlob): string => JSON.stringify(b);

const isList = (v: unknown): v is IdList => Array.isArray(v) && v.every((e) => !!e && typeof (e as { modelId?: unknown }).modelId === "string" && Array.isArray((e as { ids?: unknown }).ids));
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const finite3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number" && Number.isFinite(n));

function parseMobile(raw: unknown): MobileViewExt | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  if (typeof o.buildingId !== "string") return undefined;
  const sec = (o.section ?? {}) as { box?: { min?: unknown; max?: unknown } | null; planes?: unknown };
  const box: Box | null = sec.box && finite3(sec.box.min) && finite3(sec.box.max) ? { min: sec.box.min, max: sec.box.max } : null;
  const planes: AxisPlane[] = Array.isArray(sec.planes)
    ? sec.planes.filter((p): p is AxisPlane => !!p && AXES.includes((p as AxisPlane).axis) && Number.isFinite((p as AxisPlane).offset)).map((p) => ({ axis: p.axis, offset: p.offset, flipped: p.flipped === true }))
    : [];
  return {
    v: 1,
    buildingId: o.buildingId,
    level: typeof o.level === "string" ? o.level : null,
    cut: o.cut === true,
    section: { box, planes },
    hiddenModels: strs(o.hiddenModels),
    hiddenCategories: strs(o.hiddenCategories),
    hiddenIds: isList(o.hiddenIds) ? o.hiddenIds : [],
    forced: isList(o.forced) ? o.forced : [],
    isolated: isList(o.isolated) ? o.isolated : null,
    solid: isList(o.solid) ? o.solid : null,
  };
}

/** Tolerant decode (null = unrestorable), the same contract as the web's decoder plus the `mobile` block. */
export function decodeView(blob: string): ViewBlob | null {
  try {
    const o = JSON.parse(blob) as Record<string, unknown>;
    if (!o || typeof o !== "object" || !Array.isArray(o.sectionPlanes)) return null;
    const pose = o.pose as ViewerViewpointPose | null | undefined;
    const okPose = pose && finite3(pose.pos) && finite3(pose.target) && Number.isFinite(pose.fov);
    const out: ViewBlob = {
      pose: okPose ? { pos: pose.pos, target: pose.target, fov: pose.fov, isOrtho: pose.isOrtho === true } : null,
      sectionPlanes: o.sectionPlanes as ViewpointSectionPlane[],
    };
    if ("visibility" in o) {
      const v = o.visibility as Partial<ViewpointVisibility> | null;
      out.visibility = v && isList(v.hidden) ? { hidden: v.hidden, isolate: v.isolate && isList(v.isolate.visible) ? { visible: v.isolate.visible } : null } : null;
    }
    const mobile = parseMobile(o.mobile);
    if (mobile) out.mobile = mobile;
    return out;
  } catch {
    return null;
  }
}

/** An axis-aligned engine plane as an editable axis plane (null for a slanted one: the section panel only edits axis planes). */
export function planeToAxis(p: ViewpointSectionPlane | PlaneData): AxisPlane | null {
  const n = [p.normal.x, p.normal.y, p.normal.z];
  for (const a of AXES as readonly Axis[]) {
    const i = axisIndex(a);
    const others = n.filter((_, j) => j !== i);
    if (Math.abs(Math.abs(n[i]) - 1) < 1e-6 && others.every((c) => Math.abs(c) < 1e-6)) {
      const pt = [p.point.x, p.point.y, p.point.z];
      return { axis: a, offset: pt[i], flipped: n[i] > 0 };
    }
  }
  return null;
}

/** What restoring a view asks of the model. */
export interface RestorePlan {
  pose: ViewerViewpointPose | null;
  section: SectionState;
  level: string | null;
  cut: boolean;
  hiddenModels: string[];
  hiddenCategories: string[];
  hiddenIds: Map<string, Set<number>>;
  forced: Map<string, Set<number>>;
  isolated: Map<string, Set<number>> | null;
  solid: Map<string, Set<number>> | null;
  /** planes of a web view that this app cannot edit (dropped) */
  droppedPlanes: number;
}

export function restorePlan(b: ViewBlob): RestorePlan {
  const m = b.mobile;
  if (m) {
    return {
      pose: b.pose,
      section: { box: m.section.box, planes: m.section.planes },
      level: m.level,
      cut: m.cut && m.level !== null,
      hiddenModels: m.hiddenModels,
      hiddenCategories: m.hiddenCategories,
      hiddenIds: setsOf(m.hiddenIds),
      forced: setsOf(m.forced),
      isolated: m.isolated ? setsOf(m.isolated) : null,
      solid: m.solid ? setsOf(m.solid) : null,
      droppedPlanes: 0,
    };
  }
  // A web view: the camera, the cuts it can express as axis planes, and the hidden / isolated elements.
  const planes: AxisPlane[] = [];
  let dropped = 0;
  for (const p of b.sectionPlanes) {
    const a = planeToAxis(p);
    if (a) planes.push(a);
    else dropped++;
  }
  return {
    pose: b.pose,
    section: { box: null, planes: planes.slice(0, 8) },
    level: null,
    cut: false,
    hiddenModels: [],
    hiddenCategories: [],
    hiddenIds: setsOf(b.visibility?.hidden),
    forced: new Map(),
    isolated: b.visibility?.isolate ? setsOf(b.visibility.isolate.visible) : null,
    solid: null,
    droppedPlanes: dropped,
  };
}

// ── rows ─────────────────────────────────────────────────────────────

export interface SavedView {
  id: string;
  name: string;
  createdAt: number;
  blob: ViewBlob | null;
  /** came from the web (no building recorded) */
  fromWeb: boolean;
}

export const cleanName = (s: string): string => s.trim().replace(/\s+/g, " ").slice(0, MAX_NAME);

/** The default name of a new view ("View 3"): one more than the highest "View n" already there. */
export function defaultName(existing: readonly { name: string }[]): string {
  let n = 0;
  for (const e of existing) {
    const m = /^View (\d+)$/.exec(e.name);
    if (m) n = Math.max(n, Number(m[1]));
  }
  return `View ${Math.max(n, existing.length) + 1}`;
}

/** The project's views that belong in this building (its own, plus the web's, which are not tied to one), oldest first. */
export function viewsForBuilding(rows: readonly ViewerViewpointRecord[], buildingId: string): SavedView[] {
  return rows
    .map((r) => ({ r, blob: decodeView(r.blob) }))
    .filter(({ blob }) => !blob?.mobile || blob.mobile.buildingId === buildingId)
    .map(({ r, blob }) => ({ id: r.id, name: r.name, createdAt: r.createdAt, blob, fromWeb: !blob?.mobile }))
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

const newId = () => crypto.randomUUID();

export async function saveView(d: ViewpointDb, projectId: string, buildingId: string, name: string, blob: ViewBlob, now = Date.now(), id: string = newId()): Promise<ViewerViewpointRecord> {
  const clean = cleanName(name);
  if (!clean) throw new Error("a view needs a name");
  const own = viewsForBuilding(await d.viewerViewpoints.where("projectId").equals(projectId).toArray(), buildingId).filter((v) => !v.fromWeb);
  for (const old of own.slice(0, Math.max(0, own.length - (MAX_VIEWS_PER_BUILDING - 1)))) await d.viewerViewpoints.delete(old.id);
  const row: ViewerViewpointRecord = { id, projectId, name: clean, createdAt: now, blob: encodeView(blob) };
  await d.viewerViewpoints.put(row);
  return row;
}

export async function renameView(d: ViewpointDb, id: string, name: string): Promise<boolean> {
  const clean = cleanName(name);
  if (!clean) return false;
  return (await d.viewerViewpoints.update(id, { name: clean })) > 0;
}

export async function deleteView(d: ViewpointDb, id: string): Promise<void> {
  await d.viewerViewpoints.delete(id);
}

export function useSavedViews(projectId: string, buildingId: string): SavedView[] {
  return useLiveQuery(async () => viewsForBuilding(await appDb.viewerViewpoints.where("projectId").equals(projectId).toArray(), buildingId), [projectId, buildingId], []);
}

export { appDb as viewpointDb };
