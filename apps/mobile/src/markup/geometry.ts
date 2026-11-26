/**
 * Pure markup geometry. Stored shapes live in normalised page coordinates (u, v in 0..1 over the page, origin top-left,
 * v down; the same space as task pins). Anything that needs real proportions (distances, arcs, text boxes) converts to
 * PAGE units (u * width, v * height) first, so a circle stays a circle on a non-square sheet. No DOM, no React.
 */
import type { PlanMarkupKind, PlanMarkupPoint, PlanMarkupShape } from "@ff/types";

export interface PageSize {
  width: number;
  height: number;
}
export interface Pt {
  x: number;
  y: number;
}
export type BBox = [number, number, number, number];

export const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);
/** 5 decimals is about 0.01 mm on an A0 sheet and keeps the JSON small. */
export const roundUv = (n: number): number => Math.round(n * 1e5) / 1e5;

export const uvToPagePt = (uv: readonly [number, number], page: PageSize): Pt => ({ x: uv[0] * page.width, y: uv[1] * page.height });
export const pagePtToUv = (p: Pt, page: PageSize): PlanMarkupPoint => [p.x / page.width, p.y / page.height];

// ── shape encoding ───────────────────────────────────────────────────────

export function encodeShape(shape: PlanMarkupShape): string {
  const out: PlanMarkupShape = { pts: shape.pts.map(([u, v]) => [roundUv(u), roundUv(v)] as PlanMarkupPoint) };
  if (shape.text !== undefined) out.text = shape.text;
  if (shape.size !== undefined) out.size = roundUv(shape.size);
  return JSON.stringify(out);
}

/** Tolerant decode: a malformed remote doc yields null and is simply not drawn. */
export function decodeShape(json: string): PlanMarkupShape | null {
  try {
    const raw = JSON.parse(json) as { pts?: unknown; text?: unknown; size?: unknown };
    if (!Array.isArray(raw.pts)) return null;
    const pts: PlanMarkupPoint[] = [];
    for (const p of raw.pts) {
      if (!Array.isArray(p) || p.length !== 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) return null;
      pts.push([p[0] as number, p[1] as number]);
    }
    const shape: PlanMarkupShape = { pts };
    if (typeof raw.text === "string") shape.text = raw.text;
    if (typeof raw.size === "number" && Number.isFinite(raw.size)) shape.size = raw.size;
    return shape;
  } catch {
    return null;
  }
}

/** Minimum number of points each kind needs to be drawable. */
export const MIN_POINTS: Record<PlanMarkupKind, number> = { pen: 1, highlight: 1, arrow: 2, rect: 2, ellipse: 2, cloud: 2, text: 1 };

// ── simplification (Ramer-Douglas-Peucker) ───────────────────────────────

function perpDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  return Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / Math.sqrt(len2);
}

/** Ramer-Douglas-Peucker, iterative (a long stroke must not overflow the stack). Keeps the first and the last point. */
export function simplifyRdp<T extends Pt>(pts: readonly T[], tolerance: number): T[] {
  if (pts.length <= 2) return [...pts];
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let worst = -1;
    let at = -1;
    for (let i = s + 1; i < e; i++) {
      const d = perpDist(pts[i], pts[s], pts[e]);
      if (d > worst) {
        worst = d;
        at = i;
      }
    }
    if (worst > tolerance && at > 0) {
      keep[at] = 1;
      stack.push([s, at], [at, e]);
    }
  }
  return pts.filter((_, i) => keep[i] === 1);
}

/** Simplify with `tolerance`; when the result still exceeds `maxPoints` the tolerance doubles until it fits. */
export function simplifyToLimit<T extends Pt>(pts: readonly T[], tolerance: number, maxPoints: number): T[] {
  let tol = Math.max(tolerance, 1e-9);
  let out = simplifyRdp(pts, tol);
  for (let i = 0; i < 24 && out.length > maxPoints; i++) {
    tol *= 2;
    out = simplifyRdp(pts, tol);
  }
  return out;
}

/** Drop points closer than `minDist` to the previous kept one (raw touch samples are far denser than needed). */
export function decimate<T extends Pt>(pts: readonly T[], minDist: number): T[] {
  const out: T[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) >= minDist) out.push(p);
  }
  if (pts.length && out[out.length - 1] !== pts[pts.length - 1]) out.push(pts[pts.length - 1]);
  return out;
}

// ── bounding boxes ───────────────────────────────────────────────────────

export const TEXT_LINE_HEIGHT = 1.25;
const TEXT_CHAR_WIDTH = 0.58;

/** Page-unit box of a text markup (anchor = top-left). */
export function textBox(shape: PlanMarkupShape, page: PageSize): { x: number; y: number; w: number; h: number } {
  const [u, v] = shape.pts[0] ?? [0, 0];
  const px = (shape.size ?? 0.014) * page.width;
  const lines = (shape.text ?? "").split("\n");
  const chars = Math.max(1, ...lines.map((l) => l.length));
  return { x: u * page.width, y: v * page.height, w: chars * px * TEXT_CHAR_WIDTH, h: lines.length * px * TEXT_LINE_HEIGHT };
}

/** `[minU, minV, maxU, maxV]` of the shape (stroke excluded). */
export function computeBBox(kind: PlanMarkupKind, shape: PlanMarkupShape, page: PageSize): BBox {
  if (kind === "text") {
    const b = textBox(shape, page);
    const [u, v] = shape.pts[0] ?? [0, 0];
    return [u, v, u + b.w / page.width, v + b.h / page.height].map(roundUv) as BBox;
  }
  let minU = Infinity;
  let minV = Infinity;
  let maxU = -Infinity;
  let maxV = -Infinity;
  for (const [u, v] of shape.pts) {
    minU = Math.min(minU, u);
    minV = Math.min(minV, v);
    maxU = Math.max(maxU, u);
    maxV = Math.max(maxV, v);
  }
  if (!Number.isFinite(minU)) return [0, 0, 0, 0];
  return [minU, minV, maxU, maxV].map(roundUv) as BBox;
}

export const bboxCentre = (b: readonly number[]): [number, number] => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];

// ── transforms ───────────────────────────────────────────────────────────

/** Move a shape by (du, dv), clamped so its box stays on the page. Returns the shape and the delta actually applied. */
export function translateShape(shape: PlanMarkupShape, bbox: readonly number[], du: number, dv: number): { shape: PlanMarkupShape; du: number; dv: number } {
  const cu = Math.min(Math.max(du, -bbox[0]), 1 - bbox[2]);
  const cv = Math.min(Math.max(dv, -bbox[1]), 1 - bbox[3]);
  const fu = bbox[2] - bbox[0] >= 1 ? 0 : cu;
  const fv = bbox[3] - bbox[1] >= 1 ? 0 : cv;
  return { shape: { ...shape, pts: shape.pts.map(([u, v]) => [u + fu, v + fv] as PlanMarkupPoint) }, du: fu, dv: fv };
}

export const translateBBox = (b: readonly number[], du: number, dv: number): BBox => [b[0] + du, b[1] + dv, b[2] + du, b[3] + dv];

// ── hit testing ──────────────────────────────────────────────────────────

function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

const rectCorners = (a: Pt, b: Pt): Pt[] => [
  { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) },
  { x: Math.max(a.x, b.x), y: Math.min(a.y, b.y) },
  { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) },
  { x: Math.min(a.x, b.x), y: Math.max(a.y, b.y) },
];

/** Distance (page units) from `p` to the drawn shape, the stroke's half width already subtracted (0 = on the ink). */
export function distanceToShape(kind: PlanMarkupKind, shape: PlanMarkupShape, strokeWidth: number, p: Pt, page: PageSize): number {
  const pts = shape.pts.map((q) => uvToPagePt(q, page));
  const half = (strokeWidth * page.width) / 2;
  let d = Infinity;
  if (kind === "text") {
    const b = textBox(shape, page);
    const dx = Math.max(b.x - p.x, 0, p.x - (b.x + b.w));
    const dy = Math.max(b.y - p.y, 0, p.y - (b.y + b.h));
    return Math.hypot(dx, dy);
  }
  if (pts.length === 0) return Infinity;
  if (kind === "pen" || kind === "highlight" || kind === "arrow") {
    if (pts.length === 1) d = Math.hypot(p.x - pts[0].x, p.y - pts[0].y);
    for (let i = 0; i + 1 < pts.length; i++) d = Math.min(d, distToSegment(p, pts[i], pts[i + 1]));
  } else if (pts.length >= 2) {
    if (kind === "ellipse") {
      const cx = (pts[0].x + pts[1].x) / 2;
      const cy = (pts[0].y + pts[1].y) / 2;
      const rx = Math.max(Math.abs(pts[1].x - pts[0].x) / 2, 1e-6);
      const ry = Math.max(Math.abs(pts[1].y - pts[0].y) / 2, 1e-6);
      const k = Math.hypot((p.x - cx) / rx, (p.y - cy) / ry);
      d = Math.abs(k - 1) * Math.min(rx, ry);
    } else {
      const c = rectCorners(pts[0], pts[1]);
      for (let i = 0; i < 4; i++) d = Math.min(d, distToSegment(p, c[i], c[(i + 1) % 4]));
    }
  }
  return Math.max(0, d - half);
}

export interface HitCandidate {
  id: string;
  kind: PlanMarkupKind;
  shape: PlanMarkupShape;
  strokeWidth: number;
  createdAt: number;
}

/**
 * The markup under `p` within `tolerance` page units. Several candidates: the nearest wins and ties go to the newest
 * (drawn last, so on top).
 */
export function hitTest(items: readonly HitCandidate[], p: Pt, tolerance: number, page: PageSize): string | null {
  let best: { id: string; d: number; at: number } | null = null;
  for (const m of items) {
    const d = distanceToShape(m.kind, m.shape, m.strokeWidth, p, page);
    if (d > tolerance) continue;
    if (!best || d < best.d - 1e-9 || (Math.abs(d - best.d) <= 1e-9 && m.createdAt >= best.at)) best = { id: m.id, d, at: m.createdAt };
  }
  return best?.id ?? null;
}

// ── drawing paths (page units) ───────────────────────────────────────────

const f = (n: number) => (Math.round(n * 100) / 100).toString();

/** Smooth polyline: quadratic curves through the segment midpoints (the simplified points are the control points). */
export function smoothPath(pts: readonly Pt[]): string {
  if (pts.length === 0) return "";
  if (pts.length === 1) return `M${f(pts[0].x)} ${f(pts[0].y)}l0.01 0`; // a dot: needs a non-empty segment to show its round caps
  if (pts.length === 2) return `M${f(pts[0].x)} ${f(pts[0].y)}L${f(pts[1].x)} ${f(pts[1].y)}`;
  let d = `M${f(pts[0].x)} ${f(pts[0].y)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i].x + pts[i + 1].x) / 2;
    const my = (pts[i].y + pts[i + 1].y) / 2;
    d += `Q${f(pts[i].x)} ${f(pts[i].y)} ${f(mx)} ${f(my)}`;
  }
  const last = pts[pts.length - 1];
  return `${d}L${f(last.x)} ${f(last.y)}`;
}

export function rectPath(a: Pt, b: Pt): string {
  const [p0, p1, p2, p3] = rectCorners(a, b);
  return `M${f(p0.x)} ${f(p0.y)}L${f(p1.x)} ${f(p1.y)}L${f(p2.x)} ${f(p2.y)}L${f(p3.x)} ${f(p3.y)}Z`;
}

export function ellipsePath(a: Pt, b: Pt): string {
  const cx = (a.x + b.x) / 2;
  const cy = (a.y + b.y) / 2;
  const rx = Math.abs(b.x - a.x) / 2;
  const ry = Math.abs(b.y - a.y) / 2;
  return `M${f(cx - rx)} ${f(cy)}A${f(rx)} ${f(ry)} 0 1 0 ${f(cx + rx)} ${f(cy)}A${f(rx)} ${f(ry)} 0 1 0 ${f(cx - rx)} ${f(cy)}Z`;
}

/** Arrow: the shaft plus an open head at `head`. `headLen` in page units. */
export function arrowPath(tail: Pt, head: Pt, headLen: number): string {
  const dx = head.x - tail.x;
  const dy = head.y - tail.y;
  const len = Math.hypot(dx, dy);
  let d = `M${f(tail.x)} ${f(tail.y)}L${f(head.x)} ${f(head.y)}`;
  if (len > 1e-6) {
    const hl = Math.min(headLen, len * 0.6);
    const ang = Math.atan2(dy, dx);
    const spread = (28 * Math.PI) / 180;
    const l = { x: head.x - hl * Math.cos(ang - spread), y: head.y - hl * Math.sin(ang - spread) };
    const r = { x: head.x - hl * Math.cos(ang + spread), y: head.y - hl * Math.sin(ang + spread) };
    d += `M${f(l.x)} ${f(l.y)}L${f(head.x)} ${f(head.y)}L${f(r.x)} ${f(r.y)}`;
  }
  return d;
}

/**
 * Revision cloud around the rectangle with opposite corners `a` and `b` (page units): arcs that bulge outward along the
 * perimeter, walked clockwise (an SVG sweep flag of 1 bulges outward for a clockwise walk). Each edge gets a whole number
 * of arcs of about `scallop` units, at least two per edge, so corners land on arc joints.
 */
export function cloudPath(a: Pt, b: Pt, scallop: number): string {
  const [p0, p1, p2, p3] = rectCorners(a, b);
  const w = p1.x - p0.x;
  const h = p3.y - p0.y;
  if (w < 1e-6 || h < 1e-6) return rectPath(a, b);
  const s = Math.max(scallop, 1e-3);
  const along = (from: Pt, to: Pt, len: number): string => {
    const n = Math.max(2, Math.round(len / s));
    const r = len / n / 2; // arc radius = half the chord: a semicircle per scallop
    let out = "";
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      out += `A${f(r)} ${f(r)} 0 0 1 ${f(from.x + (to.x - from.x) * t)} ${f(from.y + (to.y - from.y) * t)}`;
    }
    return out;
  };
  return `M${f(p0.x)} ${f(p0.y)}${along(p0, p1, w)}${along(p1, p2, h)}${along(p2, p3, w)}${along(p3, p0, h)}Z`;
}

/** Scallop size for a cloud: about a quarter of the short side, clamped to a readable range of the page width. */
export function cloudScallop(a: Pt, b: Pt, page: PageSize): number {
  const side = Math.min(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
  return Math.min(0.04 * page.width, Math.max(0.012 * page.width, side / 4));
}

export const ARROW_HEAD_MIN = 0.014;

/** SVG path (page units) of a non-text markup; "" when it cannot be drawn. */
export function markupPath(kind: PlanMarkupKind, shape: PlanMarkupShape, strokeWidth: number, page: PageSize): string {
  const pts = shape.pts.map((q) => uvToPagePt(q, page));
  if (kind === "text" || pts.length < MIN_POINTS[kind]) return "";
  switch (kind) {
    case "pen":
    case "highlight":
      return smoothPath(pts);
    case "arrow":
      return arrowPath(pts[0], pts[1], Math.max(ARROW_HEAD_MIN * page.width, strokeWidth * page.width * 6));
    case "rect":
      return rectPath(pts[0], pts[1]);
    case "ellipse":
      return ellipsePath(pts[0], pts[1]);
    case "cloud":
      return cloudPath(pts[0], pts[1], cloudScallop(pts[0], pts[1], page));
  }
}

// ── styling ──────────────────────────────────────────────────────────────

/** Stroke width on screen (CSS px): the stored fraction of the page width at the current zoom, never thinner than a hairline. */
export const strokePx = (strokeWidth: number, page: PageSize, zoom: number, minPx = 1.5): number => Math.max(minPx, strokeWidth * page.width * zoom);

export const HIGHLIGHT_FACTOR = 5;
export const HIGHLIGHT_OPACITY = 0.35;

export interface WidthPreset {
  id: "thin" | "medium" | "thick";
  label: string;
  /** Pen / shapes: fraction of the page width. */
  stroke: number;
  /** Text glyph height: fraction of the page width. */
  text: number;
}

export const WIDTH_PRESETS: readonly WidthPreset[] = [
  { id: "thin", label: "Thin", stroke: 0.0015, text: 0.011 },
  { id: "medium", label: "Medium", stroke: 0.003, text: 0.016 },
  { id: "thick", label: "Thick", stroke: 0.006, text: 0.024 },
];

/** Stored stroke width for a tool and preset (the highlighter is a wide marker). */
export const strokeFor = (kind: PlanMarkupKind, preset: WidthPreset): number => (kind === "highlight" ? preset.stroke * HIGHLIGHT_FACTOR : preset.stroke);
