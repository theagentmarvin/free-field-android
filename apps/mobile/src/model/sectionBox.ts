/**
 * Section box and section planes: pure math (no engine imports, unit-tested).
 *
 * World space is Y-up, metres. A plane is `{ point, normal }` and KEEPS the half-space its normal points to
 * (the engine's clipping convention: a point `p` is drawn when `normal . (p - point) >= 0`). The box keeps its inside
 * (face normals point inward); a single axis plane keeps the lower side of its offset unless flipped.
 */
import { boxCenter, isFiniteBox, normalize, type Box, type CameraPose, type Vec3 } from "./viewMath";

export type Axis = "x" | "y" | "z";
export const AXES: readonly Axis[] = ["x", "y", "z"];
export const axisIndex = (a: Axis): 0 | 1 | 2 => (a === "x" ? 0 : a === "y" ? 1 : 2);
/** Label of an axis in the panel: Y is the height. */
export const axisLabel = (a: Axis): string => (a === "y" ? "Height" : a === "x" ? "East-West (X)" : "North-South (Z)");

export interface PlaneData {
  point: { x: number; y: number; z: number };
  normal: { x: number; y: number; z: number };
}

/** Smallest gap kept between the two faces of an axis (m): the box never collapses to a plane. */
export const MIN_GAP = 0.1;
/** Slack added around the models' box for the slider ranges (m). */
export const RANGE_PAD = 1;

const unit = (a: Axis, sign: 1 | -1): { x: number; y: number; z: number } => ({ x: a === "x" ? sign : 0, y: a === "y" ? sign : 0, z: a === "z" ? sign : 0 });

/** Plane through `value` on `axis` that keeps the side `sign` points to. */
function axisPlaneAt(a: Axis, value: number, sign: 1 | -1, around: Vec3): PlaneData {
  const p = { x: around[0], y: around[1], z: around[2] };
  p[a] = value;
  return { point: p, normal: unit(a, sign) };
}

/** The six faces of a box, in the fixed order x-min, x-max, y-min, y-max, z-min, z-max. Every normal points inward. */
export function boxPlanes(box: Box): PlaneData[] {
  const c = boxCenter(box);
  const out: PlaneData[] = [];
  for (const a of AXES) {
    const i = axisIndex(a);
    out.push(axisPlaneAt(a, box.min[i], 1, c), axisPlaneAt(a, box.max[i], -1, c));
  }
  return out;
}

/** True when the point survives every plane (it is drawn). */
export function keepsPoint(planes: readonly PlaneData[], p: Vec3, eps = 1e-9): boolean {
  return planes.every((pl) => pl.normal.x * (p[0] - pl.point.x) + pl.normal.y * (p[1] - pl.point.y) + pl.normal.z * (p[2] - pl.point.z) >= -eps);
}

/** Slider ranges: the models' box plus some slack. */
export function rangeBounds(models: Box | null): Box | null {
  if (!isFiniteBox(models)) return null;
  return {
    min: [models.min[0] - RANGE_PAD, models.min[1] - RANGE_PAD, models.min[2] - RANGE_PAD],
    max: [models.max[0] + RANGE_PAD, models.max[1] + RANGE_PAD, models.max[2] + RANGE_PAD],
  };
}

/** Move one face of the box to `value`, inside `bounds`, never closer than `gap` to the opposite face. */
export function setBoxEdge(box: Box, axis: Axis, edge: "min" | "max", value: number, bounds: Box, gap = MIN_GAP): Box {
  const i = axisIndex(axis);
  const min: Vec3 = [...box.min];
  const max: Vec3 = [...box.max];
  const lo = bounds.min[i];
  const hi = bounds.max[i];
  if (edge === "min") min[i] = Math.min(Math.max(value, lo), max[i] - gap);
  else max[i] = Math.max(Math.min(value, hi), min[i] + gap);
  return { min, max };
}

/** Clamp a box into `bounds` (keeping the minimum gap) and fix inverted sides. */
export function clampBox(box: Box, bounds: Box, gap = MIN_GAP): Box {
  const min: Vec3 = [0, 0, 0];
  const max: Vec3 = [0, 0, 0];
  for (const a of AXES) {
    const i = axisIndex(a);
    const lo = bounds.min[i];
    const hi = bounds.max[i];
    let a0 = Math.min(Math.max(Math.min(box.min[i], box.max[i]), lo), hi);
    let a1 = Math.min(Math.max(Math.max(box.min[i], box.max[i]), lo), hi);
    if (a1 - a0 < gap) {
      a1 = Math.min(a0 + gap, hi);
      a0 = Math.max(a1 - gap, lo);
    }
    min[i] = a0;
    max[i] = a1;
  }
  return { min, max };
}

/** A box `pad` metres bigger than the element's own box on every side. */
export function boxAround(elem: Box, pad = 0.5): Box {
  return { min: [elem.min[0] - pad, elem.min[1] - pad, elem.min[2] - pad], max: [elem.max[0] + pad, elem.max[1] + pad, elem.max[2] + pad] };
}

/**
 * The part of the model the camera is looking at: a box around the look-at point whose half-size is the radius the view
 * covers at that distance (shrunk a little so the cut is visible), clipped to the models. Null for a degenerate pose.
 */
export function viewBox(pose: CameraPose, models: Box, aspect = 1.6): Box | null {
  const d = Math.hypot(pose.pos[0] - pose.target[0], pose.pos[1] - pose.target[1], pose.pos[2] - pose.target[2]);
  if (!(d > 1e-6) || !isFiniteBox(models)) return null;
  const vHalf = Math.tan(((pose.fov * Math.PI) / 180) / 2);
  const half = Math.max(0.5, d * vHalf * Math.min(Math.max(aspect, 1), 2) * 0.6);
  const t = pose.target;
  const clipped = clampBox({ min: [t[0] - half, t[1] - half, t[2] - half], max: [t[0] + half, t[1] + half, t[2] + half] }, models, MIN_GAP);
  return clipped;
}

// ── single planes ────────────────────────────────────────────────────

export interface AxisPlane {
  axis: Axis;
  offset: number;
  /** false: keeps the lower side of `offset` (cuts the top / far side); true: keeps the upper side */
  flipped: boolean;
}

/** Engine plane of an axis plane. `around` supplies the other two coordinates of the plane's reference point. */
export function axisPlane(p: AxisPlane, around: Vec3): PlaneData {
  return axisPlaneAt(p.axis, p.offset, p.flipped ? 1 : -1, around);
}

/** Default offset of a new axis plane: the middle of the bounds. */
export function defaultOffset(axis: Axis, bounds: Box): number {
  const i = axisIndex(axis);
  return (bounds.min[i] + bounds.max[i]) / 2;
}

/** The axis whose horizontal component the camera looks along most: a new plane there cuts "into the screen". */
export function dominantAxis(pose: Pick<CameraPose, "pos" | "target">): Axis {
  const f = normalize([pose.target[0] - pose.pos[0], pose.target[1] - pose.pos[1], pose.target[2] - pose.pos[2]]);
  const ax = Math.abs(f[0]);
  const ay = Math.abs(f[1]);
  const az = Math.abs(f[2]);
  return ay >= ax && ay >= az ? "y" : ax >= az ? "x" : "z";
}

// ── the whole section state ──────────────────────────────────────────

export interface SectionState {
  box: Box | null;
  planes: AxisPlane[];
}

export const EMPTY_SECTION: SectionState = { box: null, planes: [] };

/** The engine planes for a state: the box faces first (6), then the single planes in order. */
export function sectionPlanes(state: SectionState, bounds: Box): PlaneData[] {
  const c = boxCenter(bounds);
  const out: PlaneData[] = state.box ? boxPlanes(state.box) : [];
  for (const p of state.planes) out.push(axisPlane(p, c));
  return out;
}

export type PlaneOp = { op: "update"; index: number; plane: PlaneData } | { op: "add"; plane: PlaneData } | { op: "remove"; index: number };

const same = (a: PlaneData, b: PlaneData) =>
  a.point.x === b.point.x && a.point.y === b.point.y && a.point.z === b.point.z && a.normal.x === b.normal.x && a.normal.y === b.normal.y && a.normal.z === b.normal.z;

/**
 * The calls that turn the viewer's current planes into `desired`: planes whose data changed are updated in place (no geometry is
 * created), missing ones added, surplus ones removed from the end (so indices stay valid as the ops apply in order).
 */
export function diffPlanes(current: readonly PlaneData[], desired: readonly PlaneData[]): PlaneOp[] {
  const ops: PlaneOp[] = [];
  const n = Math.min(current.length, desired.length);
  for (let i = 0; i < n; i++) if (!same(current[i], desired[i])) ops.push({ op: "update", index: i, plane: desired[i] });
  for (let i = n; i < desired.length; i++) ops.push({ op: "add", plane: desired[i] });
  for (let i = current.length - 1; i >= desired.length; i--) ops.push({ op: "remove", index: i });
  return ops;
}

/** A readable range for a slider value ("12.35 m"). */
export const metres = (v: number): string => `${v.toFixed(2)} m`;
