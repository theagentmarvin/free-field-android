/**
 * Pure tile-pyramid geometry (SPEC A7). No DOM, no pdf.js: everything here is
 * unit-tested and shared by the renderer (download time) and the viewer.
 *
 * Conventions
 * - Page space is PDF points, origin top-left, y down (the pdf.js viewport
 *   convention at scale 1, rotation already applied).
 * - Level z = 0 is the coarsest, z = levels.length - 1 the finest. Each level
 *   halves the previous one; `scale` is pixels per page point.
 */

export const TILE_SIZE = 256;

export interface LevelInfo {
  z: number;
  /** Pixels per page point. */
  scale: number;
  /** Level size in pixels. */
  width: number;
  height: number;
  cols: number;
  rows: number;
}

export interface PyramidOptions {
  /** Longest side of the finest level in px. */
  maxLongSide?: number;
  /** Cap on pixels per page point for the finest level. */
  maxScale?: number;
  /** Aim for a coarsest level whose longest side is at most this many px. */
  coarsestLongSide?: number;
  minLevels?: number;
  maxLevels?: number;
}

export const DEFAULT_PYRAMID: Required<PyramidOptions> = {
  maxLongSide: 6144,
  maxScale: 2,
  coarsestLongSide: 640,
  minLevels: 3,
  maxLevels: 5,
};

/** Finest-level pixel budget used by {@link adaptivePyramid}. */
export const PYRAMID_PIXEL_BUDGET = 16_000_000;

/**
 * Pyramid options by page size. Small sheets keep the default (finest level up to 2 px per point, 6144 px long
 * side). Large sheets (A1 and up, the ones that blow up pdf.js memory and render time) get a finest level of at
 * most `budget` pixels, which lowers the long side and, through `planLevels`, the level count and tile count.
 */
export function adaptivePyramid(pageW: number, pageH: number, budget = PYRAMID_PIXEL_BUDGET): PyramidOptions {
  if (!(pageW > 0) || !(pageH > 0)) return {};
  const long = Math.max(pageW, pageH);
  const byArea = Math.ceil((Math.sqrt(budget / (pageW * pageH)) * long) / 64) * 64;
  return { maxLongSide: Math.max(1024, Math.min(DEFAULT_PYRAMID.maxLongSide, byArea)) };
}

/** Level count so the coarsest level is about `coarsestLongSide`, clamped to [minLevels, maxLevels]. */
export function planLevels(pageW: number, pageH: number, opts: PyramidOptions = {}): LevelInfo[] {
  const o = { ...DEFAULT_PYRAMID, ...opts };
  if (!(pageW > 0) || !(pageH > 0)) throw new Error(`invalid page size ${pageW}x${pageH}`);
  const long = Math.max(pageW, pageH);
  const fine = Math.min(o.maxScale, o.maxLongSide / long);
  const fineLong = fine * long;
  const wanted = Math.ceil(Math.log2(Math.max(1, fineLong / o.coarsestLongSide))) + 1;
  const count = Math.min(o.maxLevels, Math.max(o.minLevels, wanted));
  const levels: LevelInfo[] = [];
  for (let z = 0; z < count; z++) {
    const scale = fine / 2 ** (count - 1 - z);
    const width = Math.max(1, Math.ceil(pageW * scale));
    const height = Math.max(1, Math.ceil(pageH * scale));
    levels.push({
      z,
      scale,
      width,
      height,
      cols: Math.ceil(width / TILE_SIZE),
      rows: Math.ceil(height / TILE_SIZE),
    });
  }
  return levels;
}

export function totalTiles(levels: readonly LevelInfo[]): number {
  return levels.reduce((n, l) => n + l.cols * l.rows, 0);
}

/** Pixel rect of tile (x, y) inside its level; edge tiles are clipped, never padded. */
export function tilePixelRect(level: LevelInfo, x: number, y: number) {
  const px = x * TILE_SIZE;
  const py = y * TILE_SIZE;
  return { px, py, w: Math.min(TILE_SIZE, level.width - px), h: Math.min(TILE_SIZE, level.height - py) };
}

/** Rect of tile (x, y) in page points. */
export function tilePageRect(level: LevelInfo, x: number, y: number) {
  const r = tilePixelRect(level, x, y);
  return { x: r.px / level.scale, y: r.py / level.scale, w: r.w / level.scale, h: r.h / level.scale };
}

export interface Region {
  /** Tile index range, end exclusive. */
  tx0: number;
  ty0: number;
  tx1: number;
  ty1: number;
  /** Pixel rect inside the level. */
  px: number;
  py: number;
  w: number;
  h: number;
}

/**
 * Split a level into rectangular regions of whole tiles, each at most
 * `maxPixels` px (the canvas cap; WebViews fail around 16 M px). Regions are
 * full-width bands when the width allows, otherwise they are split in columns.
 */
export function planRegions(level: LevelInfo, maxPixels: number): Region[] {
  const perTile = TILE_SIZE * TILE_SIZE;
  if (maxPixels < perTile) throw new Error(`maxPixels ${maxPixels} smaller than one tile`);
  const maxTiles = Math.floor(maxPixels / perTile);
  const rc = Math.min(level.cols, maxTiles);
  const rr = Math.max(1, Math.min(level.rows, Math.floor(maxTiles / rc)));
  const out: Region[] = [];
  for (let ty = 0; ty < level.rows; ty += rr) {
    for (let tx = 0; tx < level.cols; tx += rc) {
      const tx1 = Math.min(level.cols, tx + rc);
      const ty1 = Math.min(level.rows, ty + rr);
      const px = tx * TILE_SIZE;
      const py = ty * TILE_SIZE;
      out.push({
        tx0: tx,
        ty0: ty,
        tx1,
        ty1,
        px,
        py,
        w: Math.min(level.width, tx1 * TILE_SIZE) - px,
        h: Math.min(level.height, ty1 * TILE_SIZE) - py,
      });
    }
  }
  return out;
}

/**
 * Coarsest level that still has at least `threshold` of the device resolution
 * needed. `pxPerPoint` = zoom (CSS px per point) * devicePixelRatio. A threshold
 * below 1 accepts a slightly soft level to save memory and decode time.
 */
export function selectLevel(levels: readonly LevelInfo[], pxPerPoint: number, threshold = 0.75): LevelInfo {
  for (const l of levels) if (l.scale >= pxPerPoint * threshold) return l;
  return levels[levels.length - 1];
}

export interface PageRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Tile indices of `level` intersecting a page-space rect (clamped to the level). */
export function tilesInRect(level: LevelInfo, rect: PageRect): { x: number; y: number }[] {
  const tsPt = TILE_SIZE / level.scale;
  const x0 = Math.max(0, Math.floor(rect.x0 / tsPt));
  const y0 = Math.max(0, Math.floor(rect.y0 / tsPt));
  const x1 = Math.min(level.cols - 1, Math.floor(rect.x1 / tsPt));
  const y1 = Math.min(level.rows - 1, Math.floor(rect.y1 / tsPt));
  const out: { x: number; y: number }[] = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push({ x, y });
  return out;
}

/** Parent tile one level coarser. */
export const parentTile = (x: number, y: number) => ({ x: x >> 1, y: y >> 1 });

/** What the viewer is looking at: the visible page rect (points) and the device px per point. Steers the render order. */
export interface ViewHint {
  rect: PageRect;
  pxPerPoint: number;
}

/** One schedulable piece of the pyramid: a region of a level. */
export interface WorkUnit {
  level: LevelInfo;
  region: Region;
}

/**
 * Index of the unit to render next. Level 0 first (cheap fallback for everything), then the regions of the level
 * the current zoom would show that intersect the visible rect (nearest to its centre first), then everything else
 * coarse to fine. Without a hint this is plain coarse-to-fine in the original order.
 */
export function pickNextUnit(units: readonly WorkUnit[], hint?: ViewHint, levels?: readonly LevelInfo[]): number {
  if (units.length === 0) return -1;
  const target = hint && levels && levels.length > 0 ? selectLevel(levels, hint.pxPerPoint).z : -1;
  const cx = hint ? (hint.rect.x0 + hint.rect.x1) / 2 : 0;
  const cy = hint ? (hint.rect.y0 + hint.rect.y1) / 2 : 0;
  let best = -1;
  let bestKey: [number, number, number] = [0, 0, 0];
  units.forEach((u, i) => {
    const { level: l, region: r } = u;
    let key: [number, number, number];
    if (l.z === 0) key = [0, 0, i];
    else if (hint && l.z === target) {
      const x0 = r.px / l.scale;
      const y0 = r.py / l.scale;
      const x1 = (r.px + r.w) / l.scale;
      const y1 = (r.py + r.h) / l.scale;
      const hit = x0 < hint.rect.x1 && x1 > hint.rect.x0 && y0 < hint.rect.y1 && y1 > hint.rect.y0;
      key = hit ? [1, Math.hypot((x0 + x1) / 2 - cx, (y0 + y1) / 2 - cy), i] : [2, l.z, i];
    } else key = [2, l.z, i];
    if (best < 0 || key[0] < bestKey[0] || (key[0] === bestKey[0] && (key[1] < bestKey[1] || (key[1] === bestKey[1] && key[2] < bestKey[2])))) {
      best = i;
      bestKey = key;
    }
  });
  return best;
}

/**
 * Size of the whole-page preview: the page fitted into the viewport at device resolution, long side clamped to
 * [minLong, maxLong] px. Sharp enough to read as an overview, one canvas of at most ~4 M px.
 */
export function previewSize(pageW: number, pageH: number, viewW: number, viewH: number, dpr: number, minLong = 800, maxLong = 2048) {
  const fit = Math.min((viewW * dpr) / pageW, (viewH * dpr) / pageH);
  const long = Math.max(pageW, pageH);
  const scale = Math.min(maxLong / long, Math.max(minLong / long, fit));
  return { scale, width: Math.max(1, Math.ceil(pageW * scale)), height: Math.max(1, Math.ceil(pageH * scale)) };
}
