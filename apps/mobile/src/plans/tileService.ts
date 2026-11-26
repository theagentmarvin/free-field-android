import { useEffect, useState } from "react";
import { getBlobStore, sha256Hex, type BlobStore } from "../storage";
import { manifestKey, parseManifest, previewKey, type PlanManifest } from "./manifest";
import { getPlanSource, type PlanSource, type PlanVersionRef } from "./planSource";
import { openPdf } from "./pdfBackend";
import { renderTilePyramid, RenderCancelledError, MAX_CANVAS_PIXELS, type RasterBackend, type RenderProgress } from "./tileRenderer";
import { adaptivePyramid, DEFAULT_PYRAMID, previewSize, type LevelInfo, type PyramidOptions, type ViewHint } from "./tileMath";
import { Sha256 } from "../offline/sha256Incremental";
import type { PdfInput } from "./pdfInput";

export type TileState =
  | { state: "unknown" }
  | { state: "none" }
  | { state: "partial"; manifest: PlanManifest }
  | { state: "ready"; manifest: PlanManifest }
  /** `manifest` appears once the layout is known and the preview is written: the viewer can open on a partial pyramid. */
  | { state: "rendering"; progress: RenderProgress; manifest?: PlanManifest }
  | { state: "error"; message: string };

/** Knobs of one render; the defaults come from {@link defaultTuning}. Overridable for A/B measurements. */
export interface RenderTuning {
  pyramid?: PyramidOptions;
  /** Cap on pixels in any single canvas. */
  maxCanvasPixels?: number;
  /** "auto": worker + OffscreenCanvas when supported (falls back to the main thread); "off": main thread. */
  worker?: "auto" | "off";
  /** Read the PDF in ranges from the BlobStore (when the source can) instead of one buffer. */
  ranged?: boolean;
  /** Drop pdf.js's operator-list cache after each level (lower peak memory, re-parses the page). */
  cleanupBetweenLevels?: boolean;
}

/**
 * Adaptive defaults: page-size based pyramid, 4 M px canvases, ranged reads when possible. Worker rendering works
 * (opt-in `worker: "auto"`) but measured a higher renderer peak on the A0 sheet (see docs/spikes/plans.md), so the main thread is the default.
 */
export function defaultTuning(pageW: number, pageH: number): Required<Omit<RenderTuning, "cleanupBetweenLevels">> & Pick<RenderTuning, "cleanupBetweenLevels"> {
  return { pyramid: adaptivePyramid(pageW, pageH), maxCanvasPixels: 4 * 1024 * 1024, worker: "off", ranged: true, cleanupBetweenLevels: false };
}

/** The pre-optimisation behaviour (6144 px finest level, 8 M px canvases, main thread, whole-file buffer). */
export const LEGACY_TUNING: Required<Omit<RenderTuning, "cleanupBetweenLevels">> = {
  pyramid: { ...DEFAULT_PYRAMID },
  maxCanvasPixels: MAX_CANVAS_PIXELS,
  worker: "off",
  ranged: false,
};

export interface RenderStats {
  planVersionId: string;
  ms: number;
  fetchMs: number;
  tiles: number;
  skipped: number;
  pdfBytes: number;
  /** Where pdf.js ran and how the PDF was read. */
  mode: "worker" | "main";
  ranged: boolean;
  /** Set when the worker could not be used and the main thread rendered instead. */
  workerError?: string;
  finestScale: number;
  levels: number;
  /** Wall ms per level (render + encode + write; levels run in priority order, so these are sums per level). */
  levelMs: number[];
  /** Milestones in ms since the job started (see `RenderMarks`). */
  marks: RenderMarks;
}

/** Where the first seconds of a render go. All values are ms since the job started. */
export interface RenderMarks {
  /** PDF bytes available (read from the store or fetched) and hashed when needed. */
  inputMs: number;
  /** of which: sha256 over the file (0 when the verified download already supplied it). */
  hashMs: number;
  /** pdf.js document and page 1 opened (header, xref, page tree). */
  openMs: number;
  /** Whole-page preview rendered, encoded and written (includes parsing page 1's operator list). */
  previewMs: number;
  /** The preview size in px, 0 when it was skipped or failed. */
  previewPx: number;
  /** First pyramid tile written. */
  firstTileMs: number;
  /** All tiles written. */
  totalMs: number;
}

type Listener = () => void;

interface Job {
  controller: AbortController;
  promise: Promise<PlanManifest>;
  progress: RenderProgress;
  /** Layout, once the preview is in place. */
  manifest?: PlanManifest;
  hint?: ViewHint;
}

/**
 * Download-time tile rendering: fetch the PDF (through the PlanSource), render
 * the pyramid into the BlobStore, publish state to the UI. One render at a time
 * (a second would double peak memory); extra requests queue behind it.
 */
export class TileService {
  private jobs = new Map<string, Job>();
  private errors = new Map<string, string>();
  private listeners = new Set<Listener>();
  private chain: Promise<unknown> = Promise.resolve();
  lastStats: RenderStats | null = null;
  /** Number of renders started (diagnostics: tests assert that opening a plan does not start one). */
  runs = 0;

  constructor(
    private readonly store: () => BlobStore = getBlobStore,
    private readonly source: () => PlanSource = getPlanSource,
  ) {}

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  private emit() {
    this.listeners.forEach((l) => l());
  }

  async manifest(planVersionId: string): Promise<PlanManifest | null> {
    return parseManifest(await this.store().read(manifestKey(planVersionId)));
  }

  async status(planVersionId: string): Promise<TileState> {
    const job = this.jobs.get(planVersionId);
    if (job) return { state: "rendering", progress: job.progress, manifest: job.manifest };
    const err = this.errors.get(planVersionId);
    if (err) return { state: "error", message: err };
    const m = await this.manifest(planVersionId);
    if (!m) return { state: "none" };
    return m.complete ? { state: "ready", manifest: m } : { state: "partial", manifest: m };
  }

  /** The viewer reports what it shows; the running render does the visible regions before the rest. */
  setViewHint(planVersionId: string, hint: ViewHint): void {
    const job = this.jobs.get(planVersionId);
    if (job) job.hint = hint;
  }

  cancel(planVersionId: string): void {
    this.jobs.get(planVersionId)?.controller.abort();
  }

  /** Render (or resume) the tiles of a version. Concurrent calls for one version share the job. */
  ensureTiles(ref: PlanVersionRef, tuning?: RenderTuning): Promise<PlanManifest> {
    const existing = this.jobs.get(ref.planVersionId);
    if (existing) return existing.promise;
    const controller = new AbortController();
    const job: Job = {
      controller,
      progress: { done: 0, total: 0, skipped: 0, level: 0 },
      promise: undefined as unknown as Promise<PlanManifest>,
    };
    this.errors.delete(ref.planVersionId);
    job.promise = this.chain
      .catch(() => undefined)
      .then(() => this.run(ref, job, tuning))
      .catch((e: unknown) => {
        if (!(e instanceof RenderCancelledError)) {
          console.error("[plans] render failed", ref.planVersionId, e);
          this.errors.set(ref.planVersionId, String((e as Error)?.message ?? e));
        }
        throw e;
      })
      .finally(() => {
        this.jobs.delete(ref.planVersionId);
        this.emit();
      });
    this.chain = job.promise;
    job.promise.catch(() => undefined); // callers get the rejection; this only avoids an unhandled one
    this.jobs.set(ref.planVersionId, job);
    this.emit();
    return job.promise;
  }

  /** The PDF as bytes or as a ranged reader, plus its sha256 (known from the verified download when possible). */
  private async openInput(ref: PlanVersionRef, job: Job, wantRanged: boolean): Promise<{ input: PdfInput; sha: string; size: number; hashMs: number }> {
    const src = this.source();
    const timed = async (f: () => Promise<string>): Promise<[string, number]> => {
      if (ref.sha256) return [ref.sha256, 0];
      const t = performance.now();
      const sha = await f();
      return [sha, performance.now() - t];
    };
    if (wantRanged && src.openRanged) {
      const ranged = await src.openRanged(ref);
      if (ranged && ranged.kind === "ranged") {
        const [sha, hashMs] = await timed(() => hashRanged(ranged, job.controller.signal));
        return { input: ranged, sha, size: ranged.length, hashMs };
      }
    }
    const bytes = await src.fetchPdf(ref, job.controller.signal);
    const [sha, hashMs] = await timed(() => sha256Hex(bytes));
    return { input: { kind: "bytes", bytes }, sha, size: bytes.length, hashMs };
  }

  /** Render the whole page once at about viewport size and store it; resolves its longest side in px (0: skipped or failed). */
  private async writePreview(store: BlobStore, planVersionId: string, backend: RasterBackend, m: PlanManifest): Promise<number> {
    try {
      if (await store.stat(previewKey(planVersionId))) return 0; // kept from an earlier (partial) run
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const sz = previewSize(m.pageWidth, m.pageHeight, window.innerWidth || 1024, window.innerHeight || 768, dpr);
      const level: LevelInfo = { z: -1, scale: sz.scale, width: sz.width, height: sz.height, cols: 1, rows: 1 };
      const region = await backend.renderRegion(level, 0, 0, sz.width, sz.height);
      let bytes: Uint8Array;
      try {
        bytes = await region.encodeTile(0, 0, sz.width, sz.height);
      } finally {
        region.release();
      }
      await store.write(previewKey(planVersionId), bytes);
      return Math.max(sz.width, sz.height);
    } catch (e) {
      console.warn("[plans] preview failed, continuing with the tiles", e);
      return 0;
    }
  }

  private async run(ref: PlanVersionRef, job: Job, override?: RenderTuning): Promise<PlanManifest> {
    this.runs++;
    const store = this.store();
    const t0 = performance.now();
    const wantRanged = override?.ranged ?? true;
    const { input, sha, size, hashMs } = await this.openInput(ref, job, wantRanged);
    const fetchMs = performance.now() - t0;
    const pdf = await openPdf(input, { worker: override?.worker ?? "off" });
    const sinceStart = () => Math.round(performance.now() - t0);
    const marks: RenderMarks = { inputMs: Math.round(fetchMs), hashMs: Math.round(hashMs), openMs: sinceStart(), previewMs: 0, previewPx: 0, firstTileMs: 0, totalMs: 0 };
    try {
      if (pdf.pageCount > 1) {
        // Multi-page documents are not plans; only page 1 is tiled.
        console.warn(`[plans] ${ref.name} has ${pdf.pageCount} pages; tiling page 1 only`);
      }
      const tuning = { ...defaultTuning(pdf.pageWidth, pdf.pageHeight), ...override };
      const levelMs: number[] = [];
      let lastReport = performance.now();
      const manifest = await renderTilePyramid({
        store,
        planVersionId: ref.planVersionId,
        sha256: sha,
        pageWidth: pdf.pageWidth,
        pageHeight: pdf.pageHeight,
        backend: pdf.backend,
        pyramid: tuning.pyramid,
        maxCanvasPixels: tuning.maxCanvasPixels,
        cleanupBetweenLevels: tuning.cleanupBetweenLevels,
        signal: job.controller.signal,
        getHint: () => job.hint,
        beforeLevels: async (m) => {
          marks.previewPx = await this.writePreview(store, ref.planVersionId, pdf.backend, m);
          marks.previewMs = sinceStart();
          lastReport = performance.now();
        },
        onManifest: (m) => {
          job.manifest = m;
          this.emit();
        },
        onProgress: (p) => {
          job.progress = p;
          const now = performance.now();
          // Time since the previous report belongs to the level that just reported (levels run in priority order).
          if (p.done > 0 || p.skipped > 0) levelMs[p.level] = (levelMs[p.level] ?? 0) + Math.round(now - lastReport);
          lastReport = now;
          if (!marks.firstTileMs && p.done > 0) marks.firstTileMs = sinceStart();
          this.emit();
        },
      });
      marks.totalMs = sinceStart();
      this.lastStats = {
        planVersionId: ref.planVersionId,
        ms: Math.round(performance.now() - t0),
        fetchMs: Math.round(fetchMs),
        tiles: job.progress.done,
        skipped: job.progress.skipped,
        pdfBytes: size,
        mode: pdf.mode,
        ranged: input.kind === "ranged",
        workerError: pdf.workerError,
        finestScale: manifest.levels[manifest.levels.length - 1].scale,
        levels: manifest.levels.length,
        levelMs,
        marks,
      };
      return manifest;
    } finally {
      await pdf.destroy();
    }
  }
}

/** sha256 of a ranged PDF, streamed in 1 MB pieces (constant memory). */
async function hashRanged(input: Extract<PdfInput, { kind: "ranged" }>, signal?: AbortSignal): Promise<string> {
  const h = new Sha256();
  const STEP = 1024 * 1024;
  for (let at = 0; at < input.length; at += STEP) {
    if (signal?.aborted) throw new RenderCancelledError();
    h.update(await input.readRange(at, Math.min(input.length, at + STEP)));
  }
  return h.digestHex();
}

let service: TileService | null = null;
export function getTileService(): TileService {
  return (service ??= new TileService());
}

/** Live tile state of one plan version (re-read on every service event). */
export function useTileState(planVersionId: string | undefined, svc: TileService = getTileService()): TileState {
  const [state, setState] = useState<TileState>({ state: "unknown" });
  useEffect(() => {
    if (!planVersionId) return;
    let live = true;
    let seq = 0;
    const refresh = () => {
      const mine = ++seq; // status() is async: only the newest answer may win
      void svc.status(planVersionId).then((s) => live && mine === seq && setState(s));
    };
    refresh();
    const unsub = svc.subscribe(refresh);
    return () => {
      live = false;
      unsub();
    };
  }, [svc, planVersionId]);
  return state;
}
