// The legacy build is transpiled and polyfilled for older Chromium (field tablets often ship an
// outdated System WebView); the main and worker bundles must come from the same build.
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import type { RasterBackend, RasterRegion } from "./tileRenderer";
import { TILE_SIZE, type LevelInfo } from "./tileMath";
import { baseDocParams } from "./pdfCommon";
import { RANGE_CHUNK_BYTES, RANGE_INITIAL_BYTES, type PdfInput } from "./pdfInput";

// Worker is bundled with the app (hashed same-origin asset); no CDN.
pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;

function makeCanvas(w: number, h: number): AnyCanvas {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

function releaseCanvas(c: AnyCanvas): void {
  // Setting the size to 0 frees the backing store immediately instead of waiting for GC.
  c.width = 0;
  c.height = 0;
}

async function canvasToWebp(c: AnyCanvas, quality: number): Promise<Uint8Array> {
  if ("convertToBlob" in c) {
    const blob = await c.convertToBlob({ type: "image/webp", quality });
    return new Uint8Array(await blob.arrayBuffer());
  }
  const blob = await new Promise<Blob | null>((res) => (c as HTMLCanvasElement).toBlob(res, "image/webp", quality));
  if (!blob) throw new Error("canvas.toBlob returned null");
  return new Uint8Array(await blob.arrayBuffer());
}

/** pdf.js canvas factory that never touches `document` (needed inside a Web Worker). */
class OffscreenCanvasFactory {
  create(width: number, height: number) {
    const canvas = new OffscreenCanvas(width, height);
    return { canvas, context: canvas.getContext("2d") };
  }
  reset(cc: { canvas: OffscreenCanvas }, width: number, height: number) {
    cc.canvas.width = width;
    cc.canvas.height = height;
  }
  destroy(cc: { canvas: OffscreenCanvas | null; context: unknown }) {
    if (cc.canvas) {
      cc.canvas.width = 0;
      cc.canvas.height = 0;
    }
    cc.canvas = null;
    cc.context = null;
  }
}

export interface CoreOpened {
  pageWidth: number;
  pageHeight: number;
  pageCount: number;
  backend: RasterBackend;
  /** Release the page, the document and the pdf.js worker. */
  destroy(): Promise<void>;
}

export interface CoreOptions {
  /** WebP quality 0..1. */
  quality?: number;
  /** Base URL for pdf.js assets (standard fonts, cmaps, wasm). */
  assetBase?: string;
  /** Inside a Web Worker: no `document`, text is drawn as paths instead of through FontFace. */
  inWorker?: boolean;
}

/** pdf.js range transport that pulls byte ranges from a PdfInput on demand. */
function rangeTransport(input: Extract<PdfInput, { kind: "ranged" }>, initial: Uint8Array) {
  class Transport extends pdfjs.PDFDataRangeTransport {
    requestDataRange(begin: number, end: number): void {
      input
        .readRange(begin, Math.min(end, input.length))
        .then((data) => this.onDataRange(begin, data))
        .catch((e) => console.warn("[plans] range read failed", begin, end, e));
    }
  }
  return new Transport(input.length, initial);
}

/** Open page 1 of a PDF with pdf.js in the current thread. Byte buffers are handed to pdf.js's own worker. */
export async function openWithPdfjs(input: PdfInput, opts: CoreOptions = {}): Promise<CoreOpened> {
  const base = opts.assetBase ?? "/pdfjs/";
  const quality = opts.quality ?? 0.88;
  const common = { ...baseDocParams(base), disableFontFace: opts.inWorker ?? false, ...(opts.inWorker ? { useWorkerFetch: true } : {}) };
  const factory = opts.inWorker ? { CanvasFactory: OffscreenCanvasFactory } : {};
  let task;
  if (input.kind === "bytes") {
    task = pdfjs.getDocument({ ...common, ...factory, data: input.bytes } as Parameters<typeof pdfjs.getDocument>[0]);
  } else {
    const initial = await input.readRange(0, Math.min(RANGE_INITIAL_BYTES, input.length));
    task = pdfjs.getDocument({
      ...common,
      ...factory,
      range: rangeTransport(input, initial),
      length: input.length,
      disableAutoFetch: true,
      disableStream: true,
      rangeChunkSize: RANGE_CHUNK_BYTES,
    } as Parameters<typeof pdfjs.getDocument>[0]);
  }
  const doc: PDFDocumentProxy = await task.promise;
  const page: PDFPageProxy = await doc.getPage(1);
  const unit = page.getViewport({ scale: 1 });

  const tileCanvas = makeCanvas(TILE_SIZE, TILE_SIZE);
  const tileCtx = tileCanvas.getContext("2d") as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

  const backend: RasterBackend = {
    async renderRegion(level: LevelInfo, px: number, py: number, w: number, h: number): Promise<RasterRegion> {
      const canvas = makeCanvas(w, h);
      const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, w, h);
      const viewport = page.getViewport({ scale: level.scale });
      try {
        await page.render({
          canvasContext: ctx,
          viewport,
          transform: [1, 0, 0, 1, -px, -py],
          background: "#ffffff",
        } as Parameters<PDFPageProxy["render"]>[0]).promise;
      } catch (e) {
        releaseCanvas(canvas);
        throw e;
      }
      return {
        async encodeTile(sx, sy, tw, th) {
          tileCanvas.width = tw; // also clears
          tileCanvas.height = th;
          tileCtx.drawImage(canvas as CanvasImageSource, sx, sy, tw, th, 0, 0, tw, th);
          return canvasToWebp(tileCanvas, quality);
        },
        release() {
          releaseCanvas(canvas);
        },
      };
    },
    // Drop pdf.js's cached operator list (it is large on vector-heavy sheets). The next render parses again.
    cleanup() {
      try {
        page.cleanup();
      } catch {
        /* already torn down */
      }
    },
  };

  return {
    pageWidth: unit.width,
    pageHeight: unit.height,
    pageCount: doc.numPages,
    backend,
    async destroy() {
      releaseCanvas(tileCanvas);
      try {
        page.cleanup();
      } catch {
        /* already torn down */
      }
      await doc.destroy();
    },
  };
}
