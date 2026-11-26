import type { LevelInfo } from "../tileMath";
import { IDENTITY_FRAME, aspectMismatch, revisionFrame, thresholdsForScale, type PageSizePt, type RevisionFrame } from "./geometry";
import { looksMisaligned, runDiff, type ChangeRegion, type RasterPage, type RunDiffOptions } from "./webCompare";

export interface CompareDiff {
  /** Raster px per base page point the diff ran at. */
  scale: number;
  /** Where the revision lands on the base (rescale + auto-align). */
  frame: RevisionFrame;
  regions: ChangeRegion[];
  addedPixels: number;
  removedPixels: number;
  /** Auto-align moved the revision by this many base points. */
  offsetPt: { x: number; y: number };
  aspectMismatch: boolean;
  /** Many changes cover most of the page: the drawings probably do not line up. */
  looksMisaligned: boolean;
  /** The two rasters have (almost) no content: nothing to compare. */
  blank: boolean;
}

export interface DiffInput {
  base: RasterPage;
  revision: RasterPage;
  /** Base level used for the rasters. */
  level: Pick<LevelInfo, "scale">;
  basePage: PageSizePt;
  revPage: PageSizePt;
}

/**
 * Diff of two rasters in the base frame, with the web engine (worker when available): auto-align, per-pixel
 * ink classes, change regions in base page points. Buffers are consumed (transferred).
 */
export async function diffRasters(input: DiffInput, opts: RunDiffOptions = {}): Promise<CompareDiff> {
  const { scale } = input.level;
  const out = await runDiff(
    { base: input.base, revision: input.revision, thresholds: thresholdsForScale(scale), scale, autoAlign: true, nudgePx: { x: 0, y: 0 } },
    opts,
  );
  const offsetPt = { x: out.offsetPx.x / scale, y: out.offsetPx.y / scale };
  const frame = revisionFrame(input.basePage, input.revPage, offsetPt);
  const regions = out.regions;
  const diffPixels = out.added + out.removed;
  return {
    scale,
    frame,
    regions,
    addedPixels: out.added,
    removedPixels: out.removed,
    offsetPt,
    aspectMismatch: aspectMismatch(input.basePage, input.revPage),
    looksMisaligned: looksMisaligned({ regions, pageWidthPt: input.basePage.width, pageHeightPt: input.basePage.height }, false),
    blank: diffPixels === 0 && regions.length === 0 && out.autoScore === 0,
  };
}

export { IDENTITY_FRAME };

export interface ChangeSummary {
  total: number;
  added: number;
  removed: number;
  modified: number;
}

export function summarizeChanges(regions: readonly ChangeRegion[]): ChangeSummary {
  const s = { total: regions.length, added: 0, removed: 0, modified: 0 };
  for (const r of regions) s[r.kind as "added" | "removed" | "modified"]++;
  return s;
}

export function changeLabel(r: ChangeRegion): string {
  return r.kind === "added" ? "Added" : r.kind === "removed" ? "Removed" : "Modified";
}
