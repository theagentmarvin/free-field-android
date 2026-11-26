/**
 * Pure view transform for the plan viewer: page points -> screen CSS px.
 *
 *   screen = zoom * R(rot) * page + (tx, ty)
 *
 * `rot` is the number of clockwise quarter turns applied to the whole plan
 * (device rotation never changes it; it is the user's rotate button).
 */

export interface PageSize {
  width: number;
  height: number;
}
export interface ViewSize {
  width: number;
  height: number;
}
export interface View {
  zoom: number;
  tx: number;
  ty: number;
  /** 0..3 clockwise quarter turns. */
  rot: number;
}
export interface Pt {
  x: number;
  y: number;
}

export const normRot = (r: number) => ((Math.round(r) % 4) + 4) % 4;

/** Linear part of the page->screen matrix for a rotation: [a, b, c, d] with x' = a x + c y, y' = b x + d y. */
export function rotMatrix(rot: number): [number, number, number, number] {
  switch (normRot(rot)) {
    case 0:
      return [1, 0, 0, 1];
    case 1:
      return [0, 1, -1, 0];
    case 2:
      return [-1, 0, 0, -1];
    default:
      return [0, -1, 1, 0];
  }
}

export function pageToScreen(v: View, p: Pt): Pt {
  const [a, b, c, d] = rotMatrix(v.rot);
  return { x: v.zoom * (a * p.x + c * p.y) + v.tx, y: v.zoom * (b * p.x + d * p.y) + v.ty };
}

export function screenToPage(v: View, s: Pt): Pt {
  const [a, b, c, d] = rotMatrix(v.rot);
  const x = (s.x - v.tx) / v.zoom;
  const y = (s.y - v.ty) / v.zoom;
  // Rotation matrices are orthonormal: inverse = transpose.
  return { x: a * x + b * y, y: c * x + d * y };
}

/** Bounding box of the rotated page on screen. */
export function pageScreenBox(v: View, page: PageSize) {
  const pts = [
    pageToScreen(v, { x: 0, y: 0 }),
    pageToScreen(v, { x: page.width, y: 0 }),
    pageToScreen(v, { x: 0, y: page.height }),
    pageToScreen(v, { x: page.width, y: page.height }),
  ];
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

/** A view that fits the whole (rotated) page inside `viewport`, centered. */
export function fitView(page: PageSize, viewport: ViewSize, rot: number, margin = 0): View {
  const odd = normRot(rot) % 2 === 1;
  const rw = odd ? page.height : page.width;
  const rh = odd ? page.width : page.height;
  const zoom = Math.min((viewport.width - 2 * margin) / rw, (viewport.height - 2 * margin) / rh);
  const v: View = { zoom, tx: 0, ty: 0, rot: normRot(rot) };
  const box = pageScreenBox(v, page);
  v.tx = (viewport.width - (box.x1 - box.x0)) / 2 - box.x0;
  v.ty = (viewport.height - (box.y1 - box.y0)) / 2 - box.y0;
  return v;
}

export function zoomLimits(page: PageSize, viewport: ViewSize, rot: number, maxZoom: number) {
  const fit = fitView(page, viewport, rot).zoom;
  return { min: fit * 0.8, max: Math.max(maxZoom, fit * 1.2), fit };
}

/** Zoom by `factor` keeping the page point under screen point `at` fixed. */
export function zoomAbout(v: View, factor: number, at: Pt, min: number, max: number): View {
  const zoom = Math.min(max, Math.max(min, v.zoom * factor));
  const k = zoom / v.zoom;
  return { ...v, zoom, tx: at.x - (at.x - v.tx) * k, ty: at.y - (at.y - v.ty) * k };
}

/** Keep the plan reachable: centered when smaller than the viewport, edges not past a margin otherwise. */
export function clampView(v: View, page: PageSize, viewport: ViewSize, slack = 0.15): View {
  const box = pageScreenBox(v, page);
  const bw = box.x1 - box.x0;
  const bh = box.y1 - box.y0;
  let dx = 0;
  let dy = 0;
  const sx = viewport.width * slack;
  const sy = viewport.height * slack;
  if (bw <= viewport.width) dx = (viewport.width - bw) / 2 - box.x0;
  else if (box.x0 > sx) dx = sx - box.x0;
  else if (box.x1 < viewport.width - sx) dx = viewport.width - sx - box.x1;
  if (bh <= viewport.height) dy = (viewport.height - bh) / 2 - box.y0;
  else if (box.y0 > sy) dy = sy - box.y0;
  else if (box.y1 < viewport.height - sy) dy = viewport.height - sy - box.y1;
  return dx === 0 && dy === 0 ? v : { ...v, tx: v.tx + dx, ty: v.ty + dy };
}

/** Change the viewport size (device rotation) keeping the page point at the old center at the new center. */
export function resizeView(v: View, oldSize: ViewSize, newSize: ViewSize): View {
  const center = screenToPage(v, { x: oldSize.width / 2, y: oldSize.height / 2 });
  return centerOn(v, center, newSize);
}

/** Place page point `p` at the viewport center. */
export function centerOn(v: View, p: Pt, viewport: ViewSize): View {
  const s = pageToScreen({ ...v, tx: 0, ty: 0 }, p);
  return { ...v, tx: viewport.width / 2 - s.x, ty: viewport.height / 2 - s.y };
}

/** Rotate by `delta` quarter turns around the viewport center. */
export function rotateView(v: View, delta: number, viewport: ViewSize): View {
  const center = screenToPage(v, { x: viewport.width / 2, y: viewport.height / 2 });
  return centerOn({ ...v, rot: normRot(v.rot + delta) }, center, viewport);
}

/** Visible page-space rect (with a screen-space margin in px), clamped to the page. */
export function visiblePageRect(v: View, page: PageSize, viewport: ViewSize, marginPx = 0) {
  const corners = [
    screenToPage(v, { x: -marginPx, y: -marginPx }),
    screenToPage(v, { x: viewport.width + marginPx, y: -marginPx }),
    screenToPage(v, { x: -marginPx, y: viewport.height + marginPx }),
    screenToPage(v, { x: viewport.width + marginPx, y: viewport.height + marginPx }),
  ];
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  return {
    x0: Math.max(0, Math.min(...xs)),
    y0: Math.max(0, Math.min(...ys)),
    x1: Math.min(page.width, Math.max(...xs)),
    y1: Math.min(page.height, Math.max(...ys)),
  };
}

// ── pins: normalized uv (0..1 over the page) <-> screen ───────────────────

export const uvToPage = (uv: readonly [number, number], page: PageSize): Pt => ({ x: uv[0] * page.width, y: uv[1] * page.height });
export const pageToUv = (p: Pt, page: PageSize): [number, number] => [p.x / page.width, p.y / page.height];

export function uvToScreen(v: View, page: PageSize, uv: readonly [number, number]): Pt {
  return pageToScreen(v, uvToPage(uv, page));
}

export function screenToUv(v: View, page: PageSize, s: Pt): [number, number] {
  return pageToUv(screenToPage(v, s), page);
}

export const uvInPage = (uv: readonly [number, number]) => uv[0] >= 0 && uv[0] <= 1 && uv[1] >= 0 && uv[1] <= 1;
