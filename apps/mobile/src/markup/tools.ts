import type { PlanMarkupKind, PlanMarkupShape } from "@ff/types";
import { clamp01, decimate, pagePtToUv, simplifyToLimit, type PageSize, type Pt } from "./geometry";

export type MarkupTool = "select" | PlanMarkupKind;

export const TOOL_LIST: ReadonlyArray<{ id: MarkupTool; label: string }> = [
  { id: "select", label: "Select" },
  { id: "pen", label: "Pen" },
  { id: "highlight", label: "Highlighter" },
  { id: "arrow", label: "Arrow" },
  { id: "rect", label: "Rectangle" },
  { id: "ellipse", label: "Ellipse" },
  { id: "cloud", label: "Cloud" },
  { id: "text", label: "Text" },
];

/** Tools that are two aimed points (the loupe helps place them). */
export const isTwoPointTool = (t: MarkupTool): t is "arrow" | "rect" | "ellipse" | "cloud" => t === "arrow" || t === "rect" || t === "ellipse" || t === "cloud";
export const isFreehandTool = (t: MarkupTool): t is "pen" | "highlight" => t === "pen" || t === "highlight";

/** Points per freehand stroke after simplification: keeps a doc to a few KB. */
export const MAX_STROKE_POINTS = 300;
/** A two-point shape smaller than this on screen is an accidental tap, not a drawing. */
export const MIN_SHAPE_PX = 10;
/** Raw touch samples closer than this (screen px) are dropped before simplification. */
export const SAMPLE_MIN_PX = 1.5;
/** Simplification tolerance on screen: invisible at the zoom the stroke was drawn at. */
export const SIMPLIFY_PX = 1.2;

/**
 * Turn the raw samples of a stroke (page units) into the stored shape: decimate, simplify (Ramer-Douglas-Peucker, tolerance
 * in screen pixels at the zoom it was drawn at), cap the point count, convert to uv and keep inside the page.
 */
export function strokeToShape(samples: readonly Pt[], zoom: number, page: PageSize): PlanMarkupShape {
  const z = Math.max(zoom, 1e-6);
  const slim = decimate(samples, SAMPLE_MIN_PX / z);
  const simple = simplifyToLimit(slim, SIMPLIFY_PX / z, MAX_STROKE_POINTS);
  return { pts: simple.map((p) => pagePtToUv(p, page)).map(([u, v]) => [clamp01(u), clamp01(v)] as [number, number]) };
}

/** Two aimed points (page units) -> shape, or null when they are too close on screen to be intentional. */
export function twoPointShape(a: Pt, b: Pt, zoom: number, page: PageSize): PlanMarkupShape | null {
  if (Math.hypot(b.x - a.x, b.y - a.y) * zoom < MIN_SHAPE_PX) return null;
  const ua = pagePtToUv(a, page);
  const ub = pagePtToUv(b, page);
  return { pts: [[clamp01(ua[0]), clamp01(ua[1])], [clamp01(ub[0]), clamp01(ub[1])]] };
}

/** Text label anchored at a page point. */
export function textShape(at: Pt, text: string, size: number, page: PageSize): PlanMarkupShape {
  const [u, v] = pagePtToUv(at, page);
  return { pts: [[clamp01(u), clamp01(v)]], text: text.trim(), size };
}

// ── palm rejection ───────────────────────────────────────────────────────

/** Contact patch (CSS px) beyond which a touch is a resting palm or a wrist, not a fingertip. */
export const PALM_MAX_PX = 72;

export interface ContactLike {
  pointerType?: string;
  width?: number;
  height?: number;
}

/**
 * Basic palm rejection. Only touches are judged: a pen or a mouse never is. A touch is a palm when its contact patch is
 * large in either direction. Browsers that cannot measure the contact report 0 or 1 (or nothing): those are accepted.
 */
export function isPalmContact(e: ContactLike, max = PALM_MAX_PX): boolean {
  if (e.pointerType !== "touch") return false;
  const w = typeof e.width === "number" && Number.isFinite(e.width) ? e.width : 0;
  const h = typeof e.height === "number" && Number.isFinite(e.height) ? e.height : 0;
  return w > max || h > max;
}

// ── one-finger stroke gesture ────────────────────────────────────────────

export type StrokeEvent = { type: "start"; x: number; y: number } | { type: "point"; x: number; y: number } | { type: "end"; x: number; y: number } | { type: "cancel" };

/**
 * One finger draws, a second one hands the gesture to pan/zoom (the stroke is dropped, nothing is committed), and a gesture
 * that began as a pinch never draws even when it ends on one finger. Same split as the Measure placement gesture.
 *
 *   idle --down(1st)--> drawing --move--> drawing --up--> idle (end)
 *   drawing --down(2nd)--> multi (cancel) --all up--> idle
 */
export class StrokeGesture {
  private ptrs = new Set<number>();
  private drawId: number | null = null;
  private multi = false;
  private last: { x: number; y: number } | null = null;

  get drawing(): boolean {
    return this.drawId !== null;
  }
  claims(id: number): boolean {
    return this.drawId === id;
  }

  down(id: number, x: number, y: number): StrokeEvent[] {
    this.ptrs.add(id);
    if (this.ptrs.size === 1 && !this.multi) {
      this.drawId = id;
      this.last = { x, y };
      return [{ type: "start", x, y }];
    }
    const was = this.drawId !== null;
    this.drawId = null;
    this.last = null;
    this.multi = true;
    return was ? [{ type: "cancel" }] : [];
  }

  move(id: number, x: number, y: number): StrokeEvent[] {
    if (this.drawId !== id) return [];
    this.last = { x, y };
    return [{ type: "point", x, y }];
  }

  up(id: number, cancelled = false): StrokeEvent[] {
    if (!this.ptrs.delete(id)) return [];
    const was = this.drawId === id;
    const at = this.last;
    if (was) {
      this.drawId = null;
      this.last = null;
    }
    if (this.ptrs.size === 0) this.multi = false;
    if (!was || !at) return [];
    return cancelled ? [{ type: "cancel" }] : [{ type: "end", x: at.x, y: at.y }];
  }
}
