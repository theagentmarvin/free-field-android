import type { BlobStore } from "../storage";
import {
  buildManifest,
  manifestKey,
  parseManifest,
  sameLayout,
  serializeManifest,
  tileKey,
  tilePrefix,
  type PlanManifest,
} from "./manifest";
import { pickNextUnit, planRegions, tilePixelRect, totalTiles, type LevelInfo, type PyramidOptions, type ViewHint, type WorkUnit } from "./tileMath";

/** Cap on pixels in any single canvas (WebViews fail around 16 M px; stay well below). */
export const MAX_CANVAS_PIXELS = 8 * 1024 * 1024;

/** One rasterized region of a level; tiles are cut out of it and encoded. */
export interface RasterRegion {
  encodeTile(sx: number, sy: number, w: number, h: number): Promise<Uint8Array>;
  /** Free the backing canvas. Always called, also on error/cancel. */
  release(): void;
}

/** What the pipeline needs from a PDF engine (pdf.js in the app, a fake in tests). */
export interface RasterBackend {
  renderRegion(level: LevelInfo, px: number, py: number, w: number, h: number): Promise<RasterRegion>;
  /** Optional: drop engine caches that grow with page complexity (called between levels when asked to). */
  cleanup?(): void;
}

export interface RenderProgress {
  /** Tiles present on disk (written now or skipped because they already existed). */
  done: number;
  total: number;
  /** Tiles skipped because a previous run already wrote them. */
  skipped: number;
  level: number;
}

export interface RenderTilesParams {
  store: BlobStore;
  planVersionId: string;
  /** sha256 hex of the PDF bytes. */
  sha256: string;
  pageWidth: number;
  pageHeight: number;
  backend: RasterBackend;
  pyramid?: PyramidOptions;
  maxCanvasPixels?: number;
  onProgress?: (p: RenderProgress) => void;
  signal?: AbortSignal;
  now?: () => number;
  /** Call `backend.cleanup()` after each level (frees engine caches at the price of re-parsing the page). */
  cleanupBetweenLevels?: boolean;
  /** Yield to the event loop between regions so the UI stays responsive. */
  yieldFn?: () => Promise<void>;
  /** Runs once after the manifest is in place and before the first level (the whole-page preview). Must not throw. */
  beforeLevels?: (manifest: PlanManifest) => Promise<void>;
  /** Called right after `beforeLevels`: the layout is known and the first tiles are about to be written. */
  onManifest?: (manifest: PlanManifest) => void;
  /** Live view of the viewer: the regions it is looking at are rendered before the rest of the pyramid. */
  getHint?: () => ViewHint | undefined;
}

export class RenderCancelledError extends Error {
  constructor() {
    super("tile render cancelled");
    this.name = "RenderCancelledError";
  }
}

const defaultYield = () => new Promise<void>((r) => setTimeout(r, 0));

async function deletePrefix(store: BlobStore, prefix: string): Promise<void> {
  for (const s of await store.list(prefix)) await store.delete(s.key);
}

/**
 * Render a plan page into the tile pyramid. Resumable: tiles that already
 * exist (and match the same PDF hash and layout) are skipped, so a killed or
 * cancelled render continues where it stopped. Coarse levels are written
 * first, so a partial pyramid is already viewable.
 */
export async function renderTilePyramid(p: RenderTilesParams): Promise<PlanManifest> {
  const now = p.now ?? Date.now;
  const yieldFn = p.yieldFn ?? defaultYield;
  const maxPx = p.maxCanvasPixels ?? MAX_CANVAS_PIXELS;
  const started = now();

  const fresh = buildManifest(p.planVersionId, p.sha256, p.pageWidth, p.pageHeight, p.pyramid, started);
  const prev = parseManifest(await p.store.read(manifestKey(p.planVersionId)));
  if (prev && sameLayout(prev, fresh)) {
    fresh.createdAt = prev.createdAt;
  } else {
    await deletePrefix(p.store, tilePrefix(p.planVersionId));
  }
  await p.store.write(manifestKey(p.planVersionId), serializeManifest({ ...fresh, complete: false }));

  const total = totalTiles(fresh.levels);
  let done = 0;
  let skipped = 0;
  const report = (level: number) => p.onProgress?.({ done, total, skipped, level });
  const checkAbort = () => {
    if (p.signal?.aborted) throw new RenderCancelledError();
  };
  report(0);

  await p.beforeLevels?.(fresh);
  p.onManifest?.(fresh);
  checkAbort();

  const units: WorkUnit[] = fresh.levels.flatMap((level) => planRegions(level, maxPx).map((region) => ({ level, region })));
  while (units.length > 0) {
    const { level, region } = units.splice(pickNextUnit(units, p.getHint?.(), fresh.levels), 1)[0];
    checkAbort();
    {
      const missing: { x: number; y: number }[] = [];
      for (let y = region.ty0; y < region.ty1; y++) {
        for (let x = region.tx0; x < region.tx1; x++) {
          const st = await p.store.stat(tileKey(p.planVersionId, level.z, x, y));
          if (st && st.size > 0) {
            done++;
            skipped++;
          } else missing.push({ x, y });
        }
      }
      if (missing.length === 0) {
        report(level.z);
      } else {
        const raster = await p.backend.renderRegion(level, region.px, region.py, region.w, region.h);
        try {
          for (const t of missing) {
            checkAbort();
            const r = tilePixelRect(level, t.x, t.y);
            const bytes = await raster.encodeTile(r.px - region.px, r.py - region.py, r.w, r.h);
            await p.store.write(tileKey(p.planVersionId, level.z, t.x, t.y), bytes);
            done++;
            report(level.z);
          }
        } finally {
          raster.release();
        }
        await yieldFn();
      }
    }
    if (p.cleanupBetweenLevels && !units.some((u) => u.level.z === level.z)) p.backend.cleanup?.(); // a level is finished
  }

  const finished: PlanManifest = { ...fresh, complete: true, renderMs: now() - started };
  await p.store.write(manifestKey(p.planVersionId), serializeManifest(finished));
  report(fresh.levels.length - 1);
  return finished;
}
