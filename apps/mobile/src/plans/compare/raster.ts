import type { BlobStore } from "../../storage";
import { tileKey, type PlanManifest } from "../manifest";
import { selectLevel, tilePageRect, type LevelInfo } from "../tileMath";
import type { RasterPage } from "./webCompare";

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function makeCanvas(w: number, h: number): { canvas: HTMLCanvasElement | OffscreenCanvas; ctx: Ctx2D } {
  const canvas: HTMLCanvasElement | OffscreenCanvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(w, h) : Object.assign(document.createElement("canvas"), { width: w, height: h });
  const ctx = canvas.getContext("2d", { willReadFrequently: true }) as Ctx2D | null;
  if (!ctx) throw new Error("2D canvas is not available");
  return { canvas, ctx };
}

export interface RasterRequest {
  store: Pick<BlobStore, "read">;
  manifest: PlanManifest;
  /** Size of the output raster (the base level, px). */
  width: number;
  height: number;
  /** Raster px per BASE page point. */
  scale: number;
  /** Where this revision's page lands in the base frame (identity for the base itself). */
  frame: { s: number; ox: number; oy: number };
  signal?: AbortSignal;
}

/** The level of `manifest` to read so the raster is not blurrier than it needs to be. */
export function levelForRaster(manifest: PlanManifest, scale: number, frameScale: number): LevelInfo {
  return selectLevel(manifest.levels, scale / frameScale, 0.75);
}

/**
 * Paints the tiles of one revision into a white `width x height` raster in the base frame and returns its pixels.
 * One level only, one tile decoded at a time: memory is the raster plus one tile. Missing tiles stay white.
 */
export async function rasterizeRevision(req: RasterRequest): Promise<RasterPage> {
  const { canvas, ctx } = makeCanvas(req.width, req.height);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, req.width, req.height);
  const level = levelForRaster(req.manifest, req.scale, req.frame.s);
  const k = req.scale;
  // rev page pt -> raster px: x_px = k * (s * x + ox)
  ctx.setTransform(k * req.frame.s, 0, 0, k * req.frame.s, k * req.frame.ox, k * req.frame.oy);
  const eps = 0.5 / (k * req.frame.s);
  for (let y = 0; y < level.rows; y++) {
    for (let x = 0; x < level.cols; x++) {
      if (req.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const bytes = await req.store.read(tileKey(req.manifest.planVersionId, level.z, x, y));
      if (!bytes) continue;
      const bmp = await createImageBitmap(new Blob([bytes as BlobPart], { type: "image/webp" }));
      const r = tilePageRect(level, x, y);
      ctx.drawImage(bmp, r.x, r.y, r.w + eps, r.h + eps);
      bmp.close?.();
    }
  }
  const data = ctx.getImageData(0, 0, req.width, req.height).data;
  // free the backing store now rather than at the next GC
  canvas.width = 0;
  canvas.height = 0;
  return { width: req.width, height: req.height, data };
}
