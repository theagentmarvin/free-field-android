import type { BlobStore } from "../storage";
import { tileKey, type PlanManifest } from "../plans/manifest";
import { selectLevel, tilePageRect, tilesInRect } from "../plans/tileMath";
import { drawTaskPin, encodeJpegUnder } from "./encode";
import type { PageSize } from "./geometry";

/**
 * HD still of the plan around a task's pin, for a task markup. Pure framing maths plus the tile compositor; the tiles come
 * from the offline tile pyramid on the device (the same pipeline the plan viewer reads), so it works without a connection.
 */
export const CAPTURE_LONG_SIDE = 2400;
/** Aim for this many pixels on the long side when the finest tiles allow it. */
export const CAPTURE_TARGET_PX = 2200;
const MIN_FRACTION = 0.3; // of the page width
const MAX_FRACTION = 0.5;
const ASPECT = 4 / 3;

export interface PageRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The page area (page units) around the pin: landscape 4:3, as wide as the finest tiles need to reach about 2200 px (within
 * 30 to 50 % of the page width), centred on the pin and kept on the page.
 */
export function pinRegion(uv: readonly [number, number], page: PageSize, finestScale: number): PageRegion {
  const wanted = CAPTURE_TARGET_PX / Math.max(finestScale, 1e-6);
  let w = Math.min(page.width * MAX_FRACTION, Math.max(page.width * MIN_FRACTION, wanted));
  let h = w / ASPECT;
  if (h > page.height) {
    h = page.height;
    w = Math.min(page.width, h * ASPECT);
  }
  const cx = uv[0] * page.width;
  const cy = uv[1] * page.height;
  return { x: Math.min(page.width - w, Math.max(0, cx - w / 2)), y: Math.min(page.height - h, Math.max(0, cy - h / 2)), w, h };
}

/** Pixels per page unit: the long side comes out at `longSide` px at most, and never above the finest tiles' scale. */
export function captureScale(region: PageRegion, finestScale: number, longSide = CAPTURE_LONG_SIDE): number {
  return Math.min(finestScale, longSide / Math.max(region.w, region.h));
}

export interface PlanCaptureInput {
  manifest: PlanManifest;
  store: BlobStore;
  /** The task's pin on the page, normalised (0..1). Drawn into the picture. */
  uv: readonly [number, number];
}

export interface PlanCapture {
  blob: Blob;
  width: number;
  height: number;
}

/** Render the capture: the finest tiles covering the region (missing tiles stay paper white), then the pin. */
export async function renderPlanCapture({ manifest, store, uv }: PlanCaptureInput): Promise<PlanCapture> {
  const page = { width: manifest.pageWidth, height: manifest.pageHeight };
  const finest = manifest.levels[manifest.levels.length - 1];
  const region = pinRegion(uv, page, finest.scale);
  const scale = captureScale(region, finest.scale);
  const cw = Math.max(1, Math.round(region.w * scale));
  const ch = Math.max(1, Math.round(region.h * scale));
  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d canvas");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, cw, ch);
  ctx.save();
  ctx.setTransform(scale, 0, 0, scale, -region.x * scale, -region.y * scale);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  const level = selectLevel(manifest.levels, scale);
  const rect = { x0: region.x, y0: region.y, x1: region.x + region.w, y1: region.y + region.h };
  const eps = 0.5 / scale;
  for (const t of tilesInRect(level, rect)) {
    const bytes = await store.read(tileKey(manifest.planVersionId, level.z, t.x, t.y)).catch(() => null);
    if (!bytes) continue;
    const bmp = await createImageBitmap(new Blob([bytes as BlobPart], { type: "image/webp" })).catch(() => null);
    if (!bmp) continue;
    const r = tilePageRect(level, t.x, t.y);
    ctx.drawImage(bmp, r.x, r.y, r.w + eps, r.h + eps);
    bmp.close?.();
  }
  ctx.restore();
  drawTaskPin(ctx, (uv[0] * page.width - region.x) * scale, (uv[1] * page.height - region.y) * scale, Math.max(cw, ch));
  const blob = await encodeJpegUnder(canvas);
  canvas.width = 0;
  canvas.height = 0;
  return { blob, width: cw, height: ch };
}
