import type { TileCache } from "../tileCache";
import { tileId } from "../tileCache";
import type { PlanManifest } from "../manifest";
import { parentTile, selectLevel, tilePageRect, tilesInRect } from "../tileMath";
import { fromBase, type RevisionFrame } from "./geometry";
import { cloudPath, type ChangeKind, type ChangeRegion } from "./webCompare";
import type { View } from "../viewMath";

export type CompareMode = "overlay" | "swipe" | "changes";

/** Two-colour overlay: ink only in the older revision is red, only in the newer one blue, in both a dark mix. */
export const REMOVED_COLOR = "#e5484d";
export const ADDED_COLOR = "#3b82f6";
/** Region colours, the web's (viewer/composite.ts KIND_COLOR): added blue, removed red, modified amber. */
export const KIND_COLOR: Record<ChangeKind, string> = { added: "#3b82f6", removed: "#e5484d", modified: "#f59e0b" };

export interface SideDraw {
  manifest: PlanManifest;
  cache: TileCache;
  /** Revision page -> base page (identity for the base). */
  frame: RevisionFrame;
}

export interface DrawStats {
  baseDrawn: number;
  revDrawn: number;
  level: number;
}

type Ctx = CanvasRenderingContext2D;

/**
 * Draw the visible tiles of one revision into `ctx`, whose transform already maps BASE page points to device px.
 * Coarser cached ancestors stand in while the wanted level loads; the load queue of `side.cache` is refreshed.
 */
export function drawSideTiles(ctx: Ctx, side: SideDraw, visibleBase: { x0: number; y0: number; x1: number; y1: number }, k: number, paper: string): { drawn: number; level: number } {
  const { manifest, cache, frame } = side;
  const levels = manifest.levels;
  ctx.save();
  ctx.translate(frame.ox, frame.oy);
  ctx.scale(frame.s, frame.s);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.fillStyle = paper;
  ctx.fillRect(0, 0, manifest.pageWidth, manifest.pageHeight);
  const level = selectLevel(levels, k * frame.s);
  const a = fromBase(frame, visibleBase.x0, visibleBase.y0);
  const b = fromBase(frame, visibleBase.x1, visibleBase.y1);
  const rect = {
    x0: Math.max(0, Math.min(a.x, b.x)),
    y0: Math.max(0, Math.min(a.y, b.y)),
    x1: Math.min(manifest.pageWidth, Math.max(a.x, b.x)),
    y1: Math.min(manifest.pageHeight, Math.max(a.y, b.y)),
  };
  const centre = { x: (rect.x0 + rect.x1) / 2, y: (rect.y0 + rect.y1) / 2 };
  const eps = 0.5 / (k * frame.s);
  const wanted: { z: number; x: number; y: number; d: number }[] = [];
  let drawn = 0;
  if (rect.x1 > rect.x0 && rect.y1 > rect.y0) {
    for (const t of tilesInRect(level, rect)) {
      const r = tilePageRect(level, t.x, t.y);
      const dec = cache.get(tileId(level.z, t.x, t.y));
      if (dec) {
        ctx.drawImage(dec.bitmap, r.x, r.y, r.w + eps, r.h + eps);
        drawn++;
        continue;
      }
      wanted.push({ z: level.z, x: t.x, y: t.y, d: Math.hypot(r.x + r.w / 2 - centre.x, r.y + r.h / 2 - centre.y) });
      let ax = t.x;
      let ay = t.y;
      for (let z = level.z - 1; z >= 0; z--) {
        ({ x: ax, y: ay } = parentTile(ax, ay));
        const anc = cache.peek(tileId(z, ax, ay));
        if (!anc) continue;
        const ar = tilePageRect(levels[z], ax, ay);
        ctx.save();
        ctx.beginPath();
        ctx.rect(r.x, r.y, r.w, r.h);
        ctx.clip();
        ctx.drawImage(anc.bitmap, ar.x, ar.y, ar.w, ar.h);
        ctx.restore();
        break;
      }
    }
  }
  ctx.restore();
  wanted.sort((p, q) => p.d - q.d);
  const base: { z: number; x: number; y: number }[] = [];
  if (level.z > 0 && rect.x1 > rect.x0) for (const t of tilesInRect(levels[0], rect)) base.push({ z: 0, x: t.x, y: t.y });
  cache.request([...base, ...wanted]);
  return { drawn, level: level.z };
}

/** Colour-tint one layer: grayscale (so coloured drawings count as ink), then ink -> `ink`, paper stays white. */
export function tintLayer(ctx: Ctx, w: number, h: number, ink: string): void {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = "color";
  ctx.fillStyle = "#808080";
  ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = "lighten";
  ctx.fillStyle = ink;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

/** Region outlines (revision clouds) in base page points; the ctx transform maps them to device px. */
export function drawRegions(ctx: Ctx, regions: readonly ChangeRegion[], selectedId: number | null, zoomPx: number, visible: { x0: number; y0: number; x1: number; y1: number }): void {
  const arc = Math.max(4, 16 / zoomPx);
  for (const r of regions) {
    const b = r.bbox;
    if (b.x > visible.x1 || b.y > visible.y1 || b.x + b.w < visible.x0 || b.y + b.h < visible.y0) continue;
    ctx.save();
    ctx.strokeStyle = KIND_COLOR[r.kind];
    ctx.lineWidth = (r.id === selectedId ? 4 : 2.5) / zoomPx;
    if (r.id === selectedId) {
      ctx.fillStyle = KIND_COLOR[r.kind] + "33";
      ctx.fillRect(b.x, b.y, b.w, b.h);
    }
    if (typeof Path2D !== "undefined") ctx.stroke(new Path2D(cloudPath(b.x, b.y, b.w, b.h, Math.min(arc, Math.min(b.w, b.h) / 2))));
    else ctx.strokeRect(b.x, b.y, b.w, b.h);
    ctx.restore();
  }
}

/** View that centres a base-page box with some padding (fit inside the viewport, never beyond `maxZoom`). */
export function viewForBox(box: { x: number; y: number; w: number; h: number }, viewport: { width: number; height: number }, maxZoom: number, pad = 2.2): View {
  const zoom = Math.min(maxZoom, viewport.width / (box.w * pad), viewport.height / (box.h * pad));
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  return { zoom, rot: 0, tx: viewport.width / 2 - cx * zoom, ty: viewport.height / 2 - cy * zoom };
}
