/** Where the magnifier bubble goes: above the finger (so the fingertip never hides it), below near the top edge, clamped sideways. */
export function loupePlacement(aim: { x: number; y: number }, bounds: { w: number; h: number }, size: number, gap = 52): { x: number; y: number; below: boolean } {
  const r = size / 2;
  const above = aim.y - gap - r;
  const below = above - r < 4;
  const cy = below ? aim.y + gap + r : above;
  const x = Math.max(r + 4, Math.min(bounds.w - r - 4, aim.x));
  const y = Math.max(r + 4, Math.min(bounds.h - r - 4, cy));
  return { x, y, below };
}

/**
 * Source rectangle (in the source bitmap's own pixels) to magnify around a CSS-pixel point: a square of `size / zoom`
 * CSS pixels, scaled by the bitmap-to-CSS ratio, clamped inside the bitmap.
 */
export function loupeSource(aim: { x: number; y: number }, cssSize: { w: number; h: number }, bitmap: { w: number; h: number }, size: number, zoom: number): { sx: number; sy: number; sw: number } {
  const kx = bitmap.w / Math.max(1, cssSize.w);
  const ky = bitmap.h / Math.max(1, cssSize.h);
  const sw = (size / zoom) * kx;
  const sh = (size / zoom) * ky;
  const sx = Math.max(0, Math.min(bitmap.w - sw, aim.x * kx - sw / 2));
  const sy = Math.max(0, Math.min(bitmap.h - sh, aim.y * ky - sh / 2));
  return { sx, sy, sw };
}
