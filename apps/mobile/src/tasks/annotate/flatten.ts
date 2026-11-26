import { decodeImage, encodeBitmap } from "../imageProcess";
import { fitWithin, MAX_PHOTO_EDGE, type Size } from "../imageMath";
import { drawShapes, type Ctx2D } from "./render";
import type { Shape } from "./model";

export interface FlattenDeps {
  decode(blob: Blob): Promise<ImageBitmap>;
  encode(
    bitmap: ImageBitmap,
    size: Size,
    draw: (ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, size: Size) => void,
  ): Promise<Blob>;
}

const defaultDeps: FlattenDeps = { decode: decodeImage, encode: encodeBitmap };

/**
 * Flatten annotations onto the (already downscaled) photo and encode a JPEG.
 * The original blob is never modified: callers keep it so the annotations can
 * be edited again later.
 */
export async function flattenAnnotated(
  original: Blob,
  shapes: readonly Shape[],
  maxEdge = MAX_PHOTO_EDGE,
  deps: FlattenDeps = defaultDeps,
): Promise<Blob> {
  const bitmap = await deps.decode(original);
  try {
    const size = fitWithin(bitmap.width, bitmap.height, maxEdge);
    return await deps.encode(bitmap, size, (ctx, s) => drawShapes(ctx as unknown as Ctx2D, shapes, s.width, s.height));
  } finally {
    bitmap.close();
  }
}
