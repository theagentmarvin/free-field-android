import type * as THREE from "three";

interface Marks {
  /** [ms since the viewer mounted, loaded-model count] at every change. */
  loaded: Array<[number, number]>;
  /** ms since mount of the first frame that drew triangles (true first geometry), or null. */
  firstTrianglesMs: number | null;
  mountedAt?: number;
  /** [fragBlobKey, start, end (performance.now), bytes] of every frag read the viewer asked for. */
  reads?: Array<[string, number, number, number]>;
}

/** Wrap a frag reader so the timeline also records when each read started and ended (test builds). */
export function timedReader(read: (key: string) => Promise<Blob | null>): (key: string) => Promise<Blob | null> {
  return async (key) => {
    const t0 = performance.now();
    const b = await read(key);
    const w = window as unknown as { __ffmLoadMarks?: Marks; __ffmReads?: Array<[string, number, number, number]> };
    (w.__ffmReads ??= []).push([key.slice(0, 8), Math.round(t0), Math.round(performance.now()), b?.size ?? 0]);
    return b;
  };
}

/**
 * Test builds only (callers gate on the test-hook flag): in-page load timeline for the device perf spec, so the numbers
 * do not depend on how fast an outside poller (adb) gets to look. `window.__ffmLoadMarks`.
 */
export function recordLoadMark(count: number, mountedAt: number, renderer: () => THREE.WebGLRenderer | null): void {
  const w = window as unknown as { __ffmLoadMarks?: Marks };
  const marks = (w.__ffmLoadMarks ??= { loaded: [], firstTrianglesMs: null });
  marks.mountedAt = mountedAt;
  marks.reads = (window as unknown as { __ffmReads?: Marks["reads"] }).__ffmReads;
  if (count === 0 && marks.loaded.length === 0) marks.firstTrianglesMs = null;
  marks.loaded.push([Math.round(performance.now() - mountedAt), count]);
  if (count > 0 && marks.firstTrianglesMs === null) {
    const tick = () => {
      if (marks.firstTrianglesMs !== null) return;
      const r = renderer();
      if (r && r.info.render.triangles > 0) marks.firstTrianglesMs = Math.round(performance.now() - mountedAt);
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
}

export function resetLoadMarks(): void {
  delete (window as unknown as { __ffmLoadMarks?: Marks }).__ffmLoadMarks;
}
