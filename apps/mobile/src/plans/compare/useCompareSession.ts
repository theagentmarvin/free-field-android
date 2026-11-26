import { useEffect, useMemo, useRef, useState } from "react";
import type { PdfVersionRecord } from "@ff/types";
import type { BlobStore } from "../../storage";
import type { PlanManifest } from "../manifest";
import { toVersionRef } from "../planModel";
import { getTileService, useTileState, type TileState } from "../tileService";
import { diffRasters, type CompareDiff } from "./diff";
import { IDENTITY_FRAME, pickDiffLevel, revisionFrame } from "./geometry";
import { rasterizeRevision } from "./raster";

export type CompareSession =
  | { phase: "preparing"; base: SideProgress; revision: SideProgress }
  | { phase: "comparing" }
  | { phase: "ready"; base: PlanManifest; revision: PlanManifest; diff: CompareDiff; ms: number }
  | { phase: "error"; message: string };

export interface SideProgress {
  state: TileState["state"];
  /** 0..1 while rendering the tiles of a revision that has none yet. */
  fraction: number;
}

const progressOf = (s: TileState): SideProgress => ({
  state: s.state,
  fraction: s.state === "rendering" && s.progress.total ? s.progress.done / s.progress.total : s.state === "ready" ? 1 : 0,
});

// A finished diff stays valid while the PDFs are the same (sha): reopening Compare, or switching modes, never recomputes.
const results = new Map<string, { diff: CompareDiff; ms: number }>();
const MAX_RESULTS = 8;
const keyOf = (a: PlanManifest, b: PlanManifest) => `${a.planVersionId}:${a.sha256}|${b.planVersionId}:${b.sha256}`;
export const clearCompareResults = () => results.clear();

/**
 * Everything Compare needs for a pair of revisions that are on the device: tiles of both (rendered on demand when
 * a revision has none yet; the PDF is local, so this works offline), then the diff on rasters built from the tiles.
 */
export function useCompareSession(file: { id: string; name: string } | undefined, base: PdfVersionRecord | undefined, revision: PdfVersionRecord | undefined, store: BlobStore): CompareSession {
  const baseState = useTileState(base?.id);
  const revState = useTileState(revision?.id);
  const [diffState, setDiffState] = useState<{ key: string; value: CompareSession } | null>(null);

  // 1. tiles for both revisions
  useEffect(() => {
    if (!file) return;
    for (const [v, st] of [[base, baseState], [revision, revState]] as const) {
      if (v && (st.state === "none" || st.state === "partial")) void getTileService().ensureTiles(toVersionRef(file, v)).catch(() => undefined);
    }
  }, [file, base, revision, baseState.state, revState.state]); // eslint-disable-line react-hooks/exhaustive-deps

  const bm = baseState.state === "ready" ? baseState.manifest : null;
  const rm = revState.state === "ready" ? revState.manifest : null;
  const pairKey = bm && rm ? keyOf(bm, rm) : null;
  const abortRef = useRef<AbortController | null>(null);

  // 2. the diff
  useEffect(() => {
    if (!bm || !rm || !pairKey) return;
    const hit = results.get(pairKey);
    if (hit) {
      setDiffState({ key: pairKey, value: { phase: "ready", base: bm, revision: rm, diff: hit.diff, ms: hit.ms } });
      return;
    }
    const ctl = new AbortController();
    abortRef.current = ctl;
    setDiffState(null);
    const t0 = performance.now();
    (async () => {
      const level = pickDiffLevel(bm.levels);
      const frame0 = revisionFrame({ width: bm.pageWidth, height: bm.pageHeight }, { width: rm.pageWidth, height: rm.pageHeight });
      const baseR = await rasterizeRevision({ store, manifest: bm, width: level.width, height: level.height, scale: level.scale, frame: IDENTITY_FRAME, signal: ctl.signal });
      const revR = await rasterizeRevision({ store, manifest: rm, width: level.width, height: level.height, scale: level.scale, frame: frame0, signal: ctl.signal });
      const diff = await diffRasters({ base: baseR, revision: revR, level, basePage: { width: bm.pageWidth, height: bm.pageHeight }, revPage: { width: rm.pageWidth, height: rm.pageHeight } }, { signal: ctl.signal });
      const ms = Math.round(performance.now() - t0);
      results.set(pairKey, { diff, ms });
      if (results.size > MAX_RESULTS) results.delete(results.keys().next().value as string);
      if (!ctl.signal.aborted) setDiffState({ key: pairKey, value: { phase: "ready", base: bm, revision: rm, diff, ms } });
    })().catch((e: unknown) => {
      if (ctl.signal.aborted || (e as { name?: string })?.name === "AbortError") return;
      console.error("[compare] failed", e);
      setDiffState({ key: pairKey, value: { phase: "error", message: String((e as Error)?.message ?? e) } });
    });
    return () => ctl.abort();
  }, [bm, rm, pairKey, store]);

  return useMemo<CompareSession>(() => {
    if (baseState.state === "error") return { phase: "error", message: baseState.message };
    if (revState.state === "error") return { phase: "error", message: revState.message };
    if (!bm || !rm) return { phase: "preparing", base: progressOf(baseState), revision: progressOf(revState) };
    if (diffState && diffState.key === pairKey) return diffState.value;
    return { phase: "comparing" };
  }, [baseState, revState, bm, rm, diffState, pairKey]);
}
