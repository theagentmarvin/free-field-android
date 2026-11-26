import { getTaskBlobStore } from "@ff/tasks";
import { fitWithin } from "../imageMath";
import { isBlobRef, type ImageRef } from "./reportModel";
import type { JpegImage } from "./pdfWriter";

/**
 * Photos for exports: fetch one image, downscale it to `maxSide` and re-encode as JPEG. One image is decoded at a time and its
 * bitmap is released before the next, so a report with thousands of photos never holds more than one decoded photo.
 */

export interface ImageSources {
  /** storage path -> a fetchable URL (blob/data/https), null when unknown */
  resolveUrl(path: string): Promise<string | null | undefined>;
  /** photo still queued in the outbox */
  readBlob?(blobKey: string): Promise<Blob | null>;
}

export const REPORT_JPEG_QUALITY = 0.7;

export async function readRefBlob(ref: ImageRef, src: ImageSources): Promise<Blob | null> {
  if (isBlobRef(ref)) {
    const key = ref.slice("blob:".length);
    return (await (src.readBlob ?? ((k) => getTaskBlobStore().get(k)))(key)) ?? null;
  }
  const url = await src.resolveUrl(ref);
  if (!url) return null;
  const res = await fetch(url);
  return res.ok ? res.blob() : null;
}

async function encodeJpeg(bmp: ImageBitmap, w: number, h: number, quality: number): Promise<Blob> {
  if (typeof OffscreenCanvas !== "undefined") {
    const c = new OffscreenCanvas(w, h);
    const g = c.getContext("2d");
    if (!g) throw new Error("2d canvas unavailable");
    g.fillStyle = "#fff";
    g.fillRect(0, 0, w, h);
    g.drawImage(bmp, 0, 0, w, h);
    return c.convertToBlob({ type: "image/jpeg", quality });
  }
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d");
  if (!g) throw new Error("2d canvas unavailable");
  g.fillStyle = "#fff";
  g.fillRect(0, 0, w, h);
  g.drawImage(bmp, 0, 0, w, h);
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error("jpeg encode failed"))), "image/jpeg", quality));
}

/** Downscaled JPEG of an image blob, or null when it cannot be decoded. */
export async function downscaleToJpeg(blob: Blob, maxSide: number, quality = REPORT_JPEG_QUALITY): Promise<(JpegImage & { mime: "image/jpeg" }) | null> {
  let bmp: ImageBitmap | null = null;
  try {
    bmp = await createImageBitmap(blob, { imageOrientation: "from-image" });
    const { width, height } = fitWithin(bmp.width, bmp.height, maxSide);
    const out = await encodeJpeg(bmp, width, height, quality);
    return { bytes: new Uint8Array(await out.arrayBuffer()), width, height, mime: "image/jpeg" };
  } catch {
    return null;
  } finally {
    bmp?.close();
  }
}

export function makeImageLoader(src: ImageSources, signal?: AbortSignal) {
  return async (ref: ImageRef, maxSide: number): Promise<JpegImage | null> => {
    if (signal?.aborted) {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    }
    let blob: Blob | null = null;
    try {
      blob = await readRefBlob(ref, src);
    } catch {
      blob = null;
    }
    return blob ? downscaleToJpeg(blob, maxSide) : null;
  };
}
