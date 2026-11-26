/** Photo pipeline limits (SPEC: max ~2560px long edge, JPEG ~0.8). */
export const MAX_PHOTO_EDGE = 2560;
export const JPEG_QUALITY = 0.8;
/** Storage rules reject objects of 10 MiB or more. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024 - 1;

export interface Size {
  width: number;
  height: number;
}

/**
 * Fit `width x height` inside a `maxEdge` square, never upscaling and keeping
 * the aspect ratio. Dimensions are whole pixels and at least 1.
 */
export function fitWithin(width: number, height: number, maxEdge = MAX_PHOTO_EDGE): Size {
  if (!(width > 0) || !(height > 0)) throw new RangeError("image dimensions must be positive");
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width: Math.round(width), height: Math.round(height) };
  const k = maxEdge / longest;
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

/** Quality for a retry when the first encode is still over the upload cap. */
export function nextQuality(q: number): number {
  return Math.max(0.4, Math.round((q - 0.15) * 100) / 100);
}
