import type { LevelInfo } from "../tileMath";
import { DEFAULT_COMPARE_SETTINGS, resolveThresholds, type DiffThresholds, type PtBox } from "./webCompare";

/** Same rule as the web engine: a revision whose width differs by more than 1 % is rescaled to the base page width. */
export const SIZE_MISMATCH_TOLERANCE = 0.01;
/** Height-vs-width ratio difference above which the revision is only scaled by width and a notice is shown. */
export const ASPECT_TOLERANCE = 0.02;
/** Pixel budget of the comparison raster (one RGBA copy per revision; the web uses 12 MP, a 3.5 GB tablet less). */
export const DIFF_MAX_PIXELS = 4_000_000;

export interface PageSizePt {
  width: number;
  height: number;
}

/** Maps a point of the revision page into the base page frame: `base = s * rev + (ox, oy)` (points). */
export interface RevisionFrame {
  s: number;
  ox: number;
  oy: number;
}

export const IDENTITY_FRAME: RevisionFrame = { s: 1, ox: 0, oy: 0 };

/** Frame of the revision in the base page: width-based scale (as the web) plus the auto-align offset in base points. */
export function revisionFrame(base: PageSizePt, rev: PageSizePt, offsetPt: { x: number; y: number } = { x: 0, y: 0 }): RevisionFrame {
  const wr = rev.width / base.width;
  const s = Math.abs(wr - 1) > SIZE_MISMATCH_TOLERANCE ? 1 / wr : 1;
  return { s, ox: offsetPt.x, oy: offsetPt.y };
}

export function aspectMismatch(base: PageSizePt, rev: PageSizePt): boolean {
  const wr = rev.width / base.width;
  return Math.abs(rev.height / base.height / wr - 1) > ASPECT_TOLERANCE;
}

export const toBase = (f: RevisionFrame, x: number, y: number) => ({ x: f.s * x + f.ox, y: f.s * y + f.oy });
export const fromBase = (f: RevisionFrame, x: number, y: number) => ({ x: (x - f.ox) / f.s, y: (y - f.oy) / f.s });

/** The largest pyramid level that fits the pixel budget (at least the coarsest one). */
export function pickDiffLevel(levels: readonly LevelInfo[], maxPixels = DIFF_MAX_PIXELS): LevelInfo {
  let best = levels[0];
  for (const l of levels) if (l.width * l.height <= maxPixels) best = l;
  return best;
}

/**
 * Web sensitivity preset ("vector"), re-scaled from the web's 144 dpi (2 px per point) to the comparison raster:
 * the grid cell stays 8 pt wide, and the diff-pixel count a cell needs follows the line length that fits in it.
 */
export function thresholdsForScale(pxPerPt: number): DiffThresholds {
  const k = pxPerPt / 2;
  return resolveThresholds({
    ...DEFAULT_COMPARE_SETTINGS,
    thresholds: {
      gridSize: Math.max(4, Math.round(16 * k)),
      minPixelsPerCell: Math.max(2, Math.round(6 * k)),
      proximityPx: 1,
    },
  });
}

export const regionCentre = (b: PtBox) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
