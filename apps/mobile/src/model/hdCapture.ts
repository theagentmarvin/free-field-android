import { drawTaskPin, encodeJpegUnder } from "../markup/encode";

/**
 * HD still of the 3D view for a task markup. Pure helpers (pixel ratio, pin placement, encode loop) plus the one-frame
 * read-back. The capture happens inside the ONE live viewer; the markup page unmounts it right after, so no second viewer exists.
 */

/** Long side of the capture in device pixels. */
export const HD_LONG_SIDE = 2400;
/** The ratio asked for when the screen allows it (the resting ratio of the viewer is lower to spare memory). */
export const HD_TARGET_RATIO = 2;
/** The camera and the tiles get this long to settle before the frame is read. */
export const SETTLE_MS = 700;

/**
 * Pixel ratio for the capture frame: about 2x, never below the ratio the viewer already uses, never so high that the long
 * side passes `HD_LONG_SIDE` (tablet memory), and never above the 2x target.
 */
export function hdPixelRatio(cssW: number, cssH: number, current: number, target = HD_TARGET_RATIO, longSide = HD_LONG_SIDE): number {
  const long = Math.max(cssW, cssH);
  if (!(long > 0)) return current;
  const cap = longSide / long;
  return Math.max(current, Math.min(target, cap));
}

/** Pixel size of the capture for a stage of `cssW x cssH` rendered at `ratio`. */
export function captureSize(cssW: number, cssH: number, ratio: number): { width: number; height: number } {
  return { width: Math.max(1, Math.round(cssW * ratio)), height: Math.max(1, Math.round(cssH * ratio)) };
}

export interface FrameSource {
  /** The WebGL canvas, already rendered at the HD ratio. */
  canvas: HTMLCanvasElement;
  /** Draws one frame synchronously (the buffer is only readable in the same task). */
  render(): void;
  /** Where the task pin is in CSS pixels of the stage, or null when it is off screen / unknown. */
  pin: { x: number; y: number } | null;
  /** CSS size of the stage the pin position refers to. */
  css: { width: number; height: number };
}

/** Read the live frame into a 2D canvas (same task as the render), add the pin, encode. */
export async function readFrame(src: FrameSource): Promise<{ blob: Blob; width: number; height: number }> {
  const { canvas } = src;
  const w = canvas.width;
  const h = canvas.height;
  if (!w || !h) throw new Error("the 3D canvas has no size");
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("no 2d canvas");
  ctx.fillStyle = "#ffffff"; // JPEG has no alpha
  ctx.fillRect(0, 0, w, h);
  src.render();
  ctx.drawImage(canvas, 0, 0);
  if (src.pin && src.pin.x >= 0 && src.pin.y >= 0 && src.pin.x <= src.css.width && src.pin.y <= src.css.height) {
    drawTaskPin(ctx, (src.pin.x / src.css.width) * w, (src.pin.y / src.css.height) * h, Math.max(w, h));
  }
  const blob = await encodeJpegUnder(out);
  out.width = 0; // free the pixel memory now
  out.height = 0;
  return { blob, width: w, height: h };
}
