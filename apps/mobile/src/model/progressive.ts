import { useEffect, useMemo, useRef, useState } from "react";
import type { IfcFileListItem } from "@ff/viewer-react";
import { testHooksEnabled } from "../dev/flag";

const MB = 1024 * 1024;

/** Batch sizes (bytes of `.frag`). The first batch is small so the first geometry shows early; later ones are big
 * enough to keep the engine's worker pool busy (a worker parses one model at a time). */
export const FIRST_BATCH_BYTES = 8 * MB;
export const NEXT_BATCH_BYTES = 200 * MB;

/**
 * Order the federation for progressive loading: smallest `.frag` first (unknown sizes keep their order, in front), cut into
 * batches (at least one model each). Pure.
 */
export function planBatches(files: readonly IfcFileListItem[], sizes: ReadonlyMap<string, number>, first = FIRST_BATCH_BYTES, next = NEXT_BATCH_BYTES): IfcFileListItem[][] {
  const sized = files.map((f, i) => ({ f, i, size: sizes.get(f.file.id) ?? 0 }));
  sized.sort((a, b) => a.size - b.size || a.i - b.i);
  const out: IfcFileListItem[][] = [];
  let cur: IfcFileListItem[] = [];
  let bytes = 0;
  for (const { f, size } of sized) {
    const cap = out.length === 0 ? first : next;
    if (cur.length > 0 && bytes + size > cap) {
      out.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(f);
    bytes += size;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/** How many batches to release, given what is loaded: the next one goes out once every released model is in. Pure. */
export function releasedAfter(released: number, batchSizes: readonly number[], loaded: number): number {
  if (released >= batchSizes.length) return released;
  const inReleased = batchSizes.slice(0, released).reduce((a, b) => a + b, 0);
  return loaded >= inReleased ? released + 1 : released;
}

/** A released batch that never finishes (a model that fails to load) must not hold the rest back forever. */
const STALL_MS = 30_000;
/** Pause between batches so the first pass's tile streaming is not starved by the next parse. */
const GAP_MS = 150;

/**
 * Progressive federation: hands the viewer one batch of models at a time (smallest first); the next batch is released
 * when the previous one is loaded. `resetKey` restarts from the first batch (viewer rebuilt). Returns the files to
 * give the viewer and whether every model has been released.
 */
export function useProgressiveFiles(files: readonly IfcFileListItem[], sizes: ReadonlyMap<string, number>, loaded: number, resetKey: string, enabled = true): { files: IfcFileListItem[]; complete: boolean } {
  const batches = useMemo(() => planBatches(files, sizes), [files, sizes]);
  const [state, setState] = useState({ key: resetKey, released: 1 });
  const released = state.key === resetKey ? state.released : 1;
  const sizesOfBatches = useMemo(() => batches.map((b) => b.length), [batches]);
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;

  useEffect(() => {
    if (!enabled || released >= batches.length) return;
    const advance = () => setState((s) => (s.key === resetKey ? { key: resetKey, released: Math.max(s.released, releasedAfter(s.released, sizesOfBatches, Number.POSITIVE_INFINITY)) } : { key: resetKey, released: 2 }));
    if (releasedAfter(released, sizesOfBatches, loaded) === released) {
      const stall = window.setTimeout(advance, STALL_MS);
      return () => window.clearTimeout(stall);
    }
    const t = window.setTimeout(advance, GAP_MS);
    return () => window.clearTimeout(t);
  }, [enabled, released, batches.length, sizesOfBatches, loaded, resetKey]);

  const shown = enabled ? released : batches.length;
  const out = useMemo(() => batches.slice(0, shown).flat(), [batches, shown]);
  return { files: out, complete: shown >= batches.length };
}

/** Test builds can switch the staging off (localStorage `ffm.progressive` = "0") to A/B it. */
export function progressiveEnabled(): boolean {
  if (!testHooksEnabled()) return true;
  try {
    return localStorage.getItem("ffm.progressive") !== "0";
  } catch {
    return true;
  }
}
