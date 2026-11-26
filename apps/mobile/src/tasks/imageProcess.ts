import { fitWithin, JPEG_QUALITY, MAX_PHOTO_EDGE, MAX_UPLOAD_BYTES, nextQuality, type Size } from "./imageMath";

/**
 * Decode, downscale and JPEG-encode a captured photo.
 *
 * `createImageBitmap` decodes (and EXIF-orients) off the main thread; the
 * encode goes through `OffscreenCanvas.convertToBlob`, which is async and also
 * runs off the main thread in the WebView. A plain canvas is the fallback.
 */
export interface ProcessedImage extends Size {
  blob: Blob;
}

type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;

function makeCanvas(w: number, h: number): AnyCanvas {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

async function encode(canvas: AnyCanvas, quality: number): Promise<Blob> {
  if ("convertToBlob" in canvas) return canvas.convertToBlob({ type: "image/jpeg", quality });
  return new Promise<Blob>((resolve, reject) =>
    (canvas as HTMLCanvasElement).toBlob(
      (b) => (b ? resolve(b) : reject(new Error("jpeg encode failed"))),
      "image/jpeg",
      quality,
    ),
  );
}

export async function decodeImage(blob: Blob): Promise<ImageBitmap> {
  return createImageBitmap(blob, { imageOrientation: "from-image" });
}

/** Draw a decoded bitmap into a JPEG within the size cap, shrinking quality if needed. */
export async function encodeBitmap(
  bitmap: ImageBitmap,
  size: Size,
  draw?: (ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, size: Size) => void,
): Promise<Blob> {
  const canvas = makeCanvas(size.width, size.height);
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) throw new Error("2d canvas unavailable");
  ctx.fillStyle = "#fff"; // JPEG has no alpha
  ctx.fillRect(0, 0, size.width, size.height);
  ctx.drawImage(bitmap, 0, 0, size.width, size.height);
  draw?.(ctx, size);
  let q = JPEG_QUALITY;
  let out = await encode(canvas, q);
  while (out.size > MAX_UPLOAD_BYTES && q > 0.4) {
    q = nextQuality(q);
    out = await encode(canvas, q);
  }
  return out;
}

export async function processPhoto(source: Blob, maxEdge = MAX_PHOTO_EDGE): Promise<ProcessedImage> {
  const bitmap = await decodeImage(source);
  try {
    const size = fitWithin(bitmap.width, bitmap.height, maxEdge);
    const blob = await encodeBitmap(bitmap, size);
    return { blob, ...size };
  } finally {
    bitmap.close();
  }
}
