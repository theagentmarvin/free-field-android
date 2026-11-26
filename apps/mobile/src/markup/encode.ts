/** Shared encode and drawing helpers of the task markup flow (capture, flatten). */

/** Target size of the encoded picture. */
export const MAX_CAPTURE_BYTES = 1.5 * 1024 * 1024;

/** Quality steps for the encode loop: the first one that fits `maxBytes` wins; the last is kept regardless. */
export const QUALITY_STEPS: readonly number[] = [0.9, 0.82, 0.74, 0.66, 0.58];

export type CanvasLike = { toBlob(cb: (b: Blob | null) => void, type?: string, quality?: number): void };

/** Encode a canvas to JPEG under `maxBytes` (quality steps down; the smallest attempt is returned when none fits). */
export async function encodeJpegUnder(canvas: CanvasLike, maxBytes = MAX_CAPTURE_BYTES, steps: readonly number[] = QUALITY_STEPS): Promise<Blob> {
  let last: Blob | null = null;
  for (const q of steps) {
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", q));
    if (!blob) continue;
    last = blob;
    if (blob.size <= maxBytes) return blob;
  }
  if (!last) throw new Error("jpeg encode failed");
  return last;
}

/** A pin on a drawing: a ring and a dot sized from the long side of the picture. Used by the plan and the 3D capture. */
export function drawTaskPin(ctx: CanvasRenderingContext2D, x: number, y: number, longSide: number): void {
  const r = Math.max(10, longSide * 0.011);
  ctx.save();
  ctx.lineWidth = Math.max(3, r * 0.3);
  ctx.strokeStyle = "#ffffff";
  ctx.fillStyle = "#2563eb";
  ctx.shadowColor = "rgba(16,24,40,0.45)";
  ctx.shadowBlur = r * 0.5;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.stroke();
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(x, y, r * 0.32, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

