/**
 * Pure camera math for the Model tab: pin projection, fit-to-view, first-person walking.
 * No engine imports so everything here is unit-tested without a GL context.
 * World space is Y-up (the viewer's convention); lengths are metres.
 */
export type Vec3 = [number, number, number];

export interface CameraPose {
  pos: Vec3;
  target: Vec3;
  /** vertical field of view in degrees */
  fov: number;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
export const normalize = (a: Vec3): Vec3 => {
  const l = len(a);
  return l > 1e-12 ? scale(a, 1 / l) : [0, 0, -1];
};
const deg = Math.PI / 180;

/** Orthonormal camera basis (right, up, forward) for a pose; world up is +Y. */
export function cameraBasis(pose: Pick<CameraPose, "pos" | "target">): { r: Vec3; u: Vec3; f: Vec3 } {
  const f = normalize(sub(pose.target, pose.pos));
  let r = cross(f, [0, 1, 0]);
  if (len(r) < 1e-6) r = [1, 0, 0]; // looking straight up/down
  r = normalize(r);
  const u = cross(r, f);
  return { r, u, f };
}

export interface ScreenPoint {
  x: number;
  y: number;
  /** distance along the view direction, metres */
  depth: number;
  /** inside the viewport (with `margin` px of slack) */
  onScreen: boolean;
}

/**
 * Project a world point to CSS pixels of a `width` x `height` viewport. Returns null when the
 * point is behind (or closer than `near` to) the camera: a plain perspective divide would mirror it.
 */
export function projectToScreen(p: Vec3, pose: CameraPose, width: number, height: number, margin = 0, near = 0.05): ScreenPoint | null {
  if (width <= 0 || height <= 0) return null;
  const { r, u, f } = cameraBasis(pose);
  const d = sub(p, pose.pos);
  const depth = dot(d, f);
  if (depth <= near) return null;
  const tanHalf = Math.tan((pose.fov * deg) / 2);
  const aspect = width / height;
  const ndcX = dot(d, r) / (depth * tanHalf * aspect);
  const ndcY = dot(d, u) / (depth * tanHalf);
  const x = ((ndcX + 1) / 2) * width;
  const y = ((1 - ndcY) / 2) * height;
  const onScreen = x >= -margin && x <= width + margin && y >= -margin && y <= height + margin;
  return { x, y, depth, onScreen };
}

export interface Box {
  min: Vec3;
  max: Vec3;
}

export function boxCenter(b: Box): Vec3 {
  return [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
}

export function isFiniteBox(b: Box | null | undefined): b is Box {
  return !!b && [...b.min, ...b.max].every(Number.isFinite) && b.max[0] >= b.min[0] && b.max[1] >= b.min[1] && b.max[2] >= b.min[2];
}

/** Union of boxes (non-finite ones are skipped); null when none is usable. */
export function unionBoxes(boxes: (Box | null | undefined)[]): Box | null {
  let out: Box | null = null;
  for (const b of boxes) {
    if (!isFiniteBox(b)) continue;
    out = out
      ? {
          min: [Math.min(out.min[0], b.min[0]), Math.min(out.min[1], b.min[1]), Math.min(out.min[2], b.min[2])],
          max: [Math.max(out.max[0], b.max[0]), Math.max(out.max[1], b.max[1]), Math.max(out.max[2], b.max[2])],
        }
      : { min: [...b.min], max: [...b.max] };
  }
  return out;
}

/**
 * Pose that frames `box` entirely: looks at its centre from `dir` (default: a 3/4 view from above)
 * at the distance where the bounding sphere fits the narrower of the two field-of-view angles.
 */
export function fitPose(box: Box, fovDeg: number, aspect: number, dir: Vec3 = [1, 0.75, 1], margin = 1.1): CameraPose {
  const centre = boxCenter(box);
  const radius = Math.max(len(sub(box.max, box.min)) / 2, 0.5);
  const vHalf = (fovDeg * deg) / 2;
  const hHalf = Math.atan(Math.tan(vHalf) * Math.max(aspect, 0.1));
  const dist = (radius * margin) / Math.sin(Math.min(vHalf, hHalf));
  return { pos: add(centre, scale(normalize(dir), dist)), target: centre, fov: fovDeg };
}

/**
 * Pose that looks at `point` along the current view direction from `dist` metres away
 * (used by "show in model" when the task carries no stored camera).
 */
export function focusPose(point: Vec3, current: CameraPose, dist = 5): CameraPose {
  const f = normalize(sub(current.target, current.pos));
  return { pos: sub(point, scale(f, dist)), target: point, fov: current.fov };
}

/**
 * Pose that flies to an element: keeps the current viewing direction, looks at the box centre and backs off until the box fills
 * about 60 % of the narrower field of view (never closer than `minDist`). Used by the model tree and the search.
 */
export function flyPose(box: Box, current: CameraPose, aspect: number, minDist = 1.5, fill = 1.6): CameraPose {
  const centre = boxCenter(box);
  const radius = Math.max(len(sub(box.max, box.min)) / 2, 0.15);
  const vHalf = (current.fov * deg) / 2;
  const hHalf = Math.atan(Math.tan(vHalf) * Math.max(aspect, 0.1));
  const dist = Math.max((radius * fill) / Math.sin(Math.min(vHalf, hHalf)), minDist);
  const back = sub(current.pos, current.target);
  const dir = len(back) > 1e-6 ? normalize(back) : normalize([1, 0.75, 1]);
  return { pos: add(centre, scale(dir, dist)), target: centre, fov: current.fov };
}

/** Prefer the stored author camera when it actually shows the pin; otherwise fly in on the pin. */
export function choosePinView(point: Vec3, stored: CameraPose | null, current: CameraPose, width: number, height: number): CameraPose {
  if (stored) {
    const s = projectToScreen(point, stored, width, height, -width * 0.05);
    if (s?.onScreen) return stored;
  }
  return focusPose(point, current);
}

// ── first-person walking ─────────────────────────────────────────────

export const EYE_HEIGHT = 1.6;
export const WALK_SPEED = 1.4; // m/s
const MAX_PITCH = 1.45; // ~83 degrees

export interface WalkState {
  x: number;
  z: number;
  /** floor elevation the eye is measured from */
  floorY: number;
  /** radians; 0 looks along -Z, positive turns right */
  yaw: number;
  /** radians; positive looks up */
  pitch: number;
}

export function walkForward(yaw: number): Vec3 {
  return [Math.sin(yaw), 0, -Math.cos(yaw)];
}

export function walkPose(s: WalkState, fov = 60, eye = EYE_HEIGHT): CameraPose {
  const pos: Vec3 = [s.x, s.floorY + eye, s.z];
  const cp = Math.cos(s.pitch);
  const dir: Vec3 = [Math.sin(s.yaw) * cp, Math.sin(s.pitch), -Math.cos(s.yaw) * cp];
  return { pos, target: add(pos, dir), fov };
}

export interface WalkInput {
  /** -1..1, positive walks forward */
  forward: number;
  /** -1..1, positive strafes right */
  strafe: number;
}

/** Advance the walker by `dtSec`. Input is clamped to the unit disc so diagonals are not faster. */
export function stepWalk(s: WalkState, input: WalkInput, dtSec: number, speed = WALK_SPEED): WalkState {
  let { forward, strafe } = input;
  const mag = Math.hypot(forward, strafe);
  if (mag > 1) {
    forward /= mag;
    strafe /= mag;
  }
  const dt = Math.min(Math.max(dtSec, 0), 0.25); // a stalled frame must not teleport
  const f = walkForward(s.yaw);
  const rx = Math.cos(s.yaw);
  const rz = Math.sin(s.yaw);
  return { ...s, x: s.x + (f[0] * forward + rx * strafe) * speed * dt, z: s.z + (f[2] * forward + rz * strafe) * speed * dt };
}

/** Drag-to-look: dragging right turns right, dragging up looks up. Pitch is clamped. */
export function lookBy(s: WalkState, dxPx: number, dyPx: number, radPerPx = 0.005): WalkState {
  const pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, s.pitch - dyPx * radPerPx));
  return { ...s, yaw: s.yaw + dxPx * radPerPx, pitch };
}

/** Start a walk where the orbit camera currently looks: same heading, eye at `EYE_HEIGHT` above `floorY`. */
export function walkFromPose(pose: Pick<CameraPose, "pos" | "target">, at: { x: number; z: number }, floorY: number): WalkState {
  const d = sub(pose.target, pose.pos);
  const yaw = Math.atan2(d[0], -d[2]);
  return { x: at.x, z: at.z, floorY, yaw: Number.isFinite(yaw) ? yaw : 0, pitch: 0 };
}

/** The storey elevation the walker stands on: highest storey at or below `y` (+ tolerance), else the lowest. */
export function floorForY(elevations: readonly number[], y: number, tolerance = 0.3): number | null {
  const e = elevations.filter(Number.isFinite);
  if (e.length === 0) return null;
  const below = e.filter((v) => v <= y + tolerance);
  return below.length ? Math.max(...below) : Math.min(...e);
}

/** The ground storey: the elevation closest to 0 (the lower one on a tie), else null. */
export function groundFloor(elevations: readonly number[]): number | null {
  const e = elevations.filter(Number.isFinite);
  if (e.length === 0) return null;
  return e.reduce((best, v) => (Math.abs(v) < Math.abs(best) || (Math.abs(v) === Math.abs(best) && v < best) ? v : best));
}

/**
 * The storey a walk starts on. From above the building (the fit view) the centre ray lands on the roof, and
 * standing there is empty space: start on the ground storey instead. From inside or beside the building, stand
 * on the storey under the point the view looks at.
 */
export function walkEntryFloor(elevations: readonly number[], lookY: number, cameraY: number, topY: number | null): number | null {
  if (topY !== null && Number.isFinite(topY) && cameraY > topY) return groundFloor(elevations);
  return floorForY(elevations, lookY);
}

/** Height of the cut plane for a storey section: `cutHeight` above its floor, never above the next storey. */
export function sectionHeight(elevations: readonly number[], storeyElevation: number, cutHeight = 1.5): number {
  const above = elevations.filter((v) => v > storeyElevation + 0.05).sort((a, b) => a - b)[0];
  const h = storeyElevation + cutHeight;
  return above !== undefined ? Math.min(h, above - 0.05) : h;
}

// ── pixel ratio ──────────────────────────────────────────────────────

export const MAX_PIXEL_RATIO = 1.5;
/** Resting render scale: the device ratio, capped. The viewer halves it again while the camera moves. */
export function cappedPixelRatio(deviceRatio: number, cap = MAX_PIXEL_RATIO): number {
  const r = Number.isFinite(deviceRatio) && deviceRatio > 0 ? deviceRatio : 1;
  return Math.min(r, cap);
}
