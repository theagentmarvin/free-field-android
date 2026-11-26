/**
 * Annotation model: pure data + an undo/redo history. Coordinates are
 * normalized to the image (0..1 on both axes) so the same shapes render at
 * any preview scale and flatten at full resolution.
 */
export type Pt = [number, number];

export type Tool = "pen" | "arrow" | "rect" | "text";

export const COLORS = ["#ff3b30", "#ffcc00", "#34c759", "#0a84ff", "#ffffff", "#000000"] as const;

export type Shape =
  | { id: string; kind: "pen"; color: string; width: number; points: Pt[] }
  | { id: string; kind: "arrow"; color: string; width: number; from: Pt; to: Pt }
  | { id: string; kind: "rect"; color: string; width: number; from: Pt; to: Pt }
  | { id: string; kind: "text"; color: string; size: number; at: Pt; text: string };

export interface History {
  /** committed shapes, bottom to top */
  shapes: readonly Shape[];
  /** snapshots we can step back to */
  past: readonly (readonly Shape[])[];
  /** snapshots we can step forward to */
  future: readonly (readonly Shape[])[];
}

export const emptyHistory: History = { shapes: [], past: [], future: [] };

/** Cap so a long session cannot grow memory without bound. */
export const MAX_UNDO = 100;

export function commit(h: History, shape: Shape): History {
  return {
    shapes: [...h.shapes, shape],
    past: [...h.past, h.shapes].slice(-MAX_UNDO),
    future: [],
  };
}

export function undo(h: History): History {
  if (h.past.length === 0) return h;
  const prev = h.past[h.past.length - 1];
  return { shapes: prev, past: h.past.slice(0, -1), future: [h.shapes, ...h.future] };
}

export function redo(h: History): History {
  if (h.future.length === 0) return h;
  const [next, ...rest] = h.future;
  return { shapes: next, past: [...h.past, h.shapes], future: rest };
}

export const canUndo = (h: History): boolean => h.past.length > 0;
export const canRedo = (h: History): boolean => h.future.length > 0;

export function clearAll(h: History): History {
  return h.shapes.length === 0 ? h : { shapes: [], past: [...h.past, h.shapes].slice(-MAX_UNDO), future: [] };
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));
export const clampPt = (p: Pt): Pt => [clamp01(p[0]), clamp01(p[1])];

/** Distance below which a drag is treated as a tap (no shape). */
export const MIN_DRAG = 0.004;

export function dragLength(a: Pt, b: Pt): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/** Stroke width as a fraction of the image's longer edge. */
export const STROKE = { thin: 0.004, medium: 0.007, thick: 0.012 } as const;
export const TEXT_SIZE = 0.04;

/** Arrow head: two barbs at +/-25 degrees, length relative to the stroke. */
export function arrowHead(from: Pt, to: Pt, headLen: number, aspect = 1): [Pt, Pt] {
  // work in aspect-correct space so the head is not skewed on wide images
  const dx = (to[0] - from[0]) * aspect;
  const dy = to[1] - from[1];
  const ang = Math.atan2(dy, dx);
  const spread = (25 * Math.PI) / 180;
  const barb = (sign: number): Pt => [
    to[0] - (Math.cos(ang + sign * spread) * headLen) / aspect,
    to[1] - Math.sin(ang + sign * spread) * headLen,
  ];
  return [barb(1), barb(-1)];
}
