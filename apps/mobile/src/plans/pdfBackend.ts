import type { RasterBackend, RasterRegion } from "./tileRenderer";
import type { LevelInfo } from "./tileMath";
import { openWithPdfjs } from "./pdfCore";
import { type PdfInput } from "./pdfInput";
import type { FromWorker, ToWorker } from "./pdfWorkerProtocol";

export type PdfMode = "worker" | "main";

export interface OpenedPdf {
  pageWidth: number;
  pageHeight: number;
  pageCount: number;
  backend: RasterBackend;
  /** Where pdf.js and the canvases live. */
  mode: PdfMode;
  /** Why the worker was not used (set when "auto" fell back to the main thread). */
  workerError?: string;
  /** Release the page, the document and the workers. */
  destroy(): Promise<void>;
}

export interface OpenPdfOptions {
  /** WebP quality 0..1. */
  quality?: number;
  /** Base URL for pdf.js assets (standard fonts, cmaps, wasm). */
  assetBase?: string;
  /**
   * "auto" (default): a Web Worker with OffscreenCanvas when the WebView supports it, otherwise the main
   * thread. "off": main thread only. "force": worker or fail (diagnostics).
   */
  worker?: "auto" | "off" | "force";
}

/** Can this WebView render tiles in a worker? (module workers, OffscreenCanvas 2D, WebP encoding off-thread) */
export function workerRenderingSupported(): boolean {
  try {
    return (
      typeof Worker !== "undefined" &&
      typeof OffscreenCanvas !== "undefined" &&
      typeof OffscreenCanvas.prototype.convertToBlob === "function" &&
      !!new OffscreenCanvas(1, 1).getContext("2d")
    );
  } catch {
    return false;
  }
}

/** Open page 1 of a PDF. Falls back to the main thread when the worker is unsupported or fails to start. */
export async function openPdf(source: Uint8Array | PdfInput, opts: OpenPdfOptions = {}): Promise<OpenedPdf> {
  const input: PdfInput = source instanceof Uint8Array ? { kind: "bytes", bytes: source } : source;
  const mode = opts.worker ?? "auto";
  let workerError: string | undefined;
  if (mode !== "off" && workerRenderingSupported()) {
    try {
      return await openInWorker(input, opts);
    } catch (e) {
      if (mode === "force") throw e;
      workerError = String((e as Error)?.message ?? e);
      console.warn("[plans] worker rendering unavailable, using the main thread:", workerError);
    }
  } else if (mode === "force") {
    throw new Error("worker rendering is not supported by this WebView");
  }
  const core = await openWithPdfjs(input, { quality: opts.quality, assetBase: opts.assetBase });
  return { ...core, mode: "main", workerError };
}

const OPEN_TIMEOUT_MS = 120_000;

async function openInWorker(input: PdfInput, opts: OpenPdfOptions): Promise<OpenedPdf> {
  const worker = new Worker(new URL("./pdfWorker.ts", import.meta.url), { type: "module" });
  let seq = 0;
  const waiting = new Map<number, { resolve(m: FromWorker): void; reject(e: Error): void }>();
  let failed: Error | null = null;
  const fail = (e: Error) => {
    failed = e;
    for (const w of waiting.values()) w.reject(e);
    waiting.clear();
  };

  const ready = new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("tile worker did not start")), 15_000);
    worker.addEventListener("message", function once(ev: MessageEvent<FromWorker>) {
      if (ev.data.t === "ready") {
        clearTimeout(t);
        worker.removeEventListener("message", once);
        resolve();
      }
    });
    worker.addEventListener("error", (e) => {
      clearTimeout(t);
      reject(new Error(e.message || "tile worker failed"));
    });
  });

  worker.addEventListener("message", (ev: MessageEvent<FromWorker>) => {
    const m = ev.data;
    if (m.t === "ready") return;
    if (m.t === "range") {
      if (input.kind !== "ranged") return;
      input
        .readRange(m.begin, m.end)
        .then((data) => worker.postMessage({ t: "rangeData", rid: m.rid, data } satisfies ToWorker, [data.buffer]))
        .catch((e) => worker.postMessage({ t: "rangeError", rid: m.rid, message: String(e?.message ?? e) } satisfies ToWorker));
      return;
    }
    const w = waiting.get(m.id);
    if (!w) return;
    waiting.delete(m.id);
    if (m.t === "error") w.reject(new Error(m.message));
    else w.resolve(m);
  });
  worker.addEventListener("error", (e) => fail(new Error(e.message || "tile worker crashed")));

  const call = <T extends FromWorker>(msg: Omit<ToWorker, "id"> & { id?: number }, transfer: Transferable[] = []): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (failed) return reject(failed);
      const id = ++seq;
      waiting.set(id, { resolve: resolve as (m: FromWorker) => void, reject });
      worker.postMessage({ ...msg, id }, transfer);
    });

  try {
    await ready;
    const open = call<Extract<FromWorker, { t: "opened" }>>({
      t: "open",
      length: input.kind === "bytes" ? input.bytes.length : input.length,
      // structured clone (a copy): the caller's buffer stays usable for the main-thread fallback
      bytes: input.kind === "bytes" ? input.bytes : undefined,
      quality: opts.quality ?? 0.88,
      assetBase: opts.assetBase ?? "/pdfjs/",
    } as never);
    const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error("opening the PDF in the worker timed out")), OPEN_TIMEOUT_MS));
    const info = await Promise.race([open, timeout]);

    const backend: RasterBackend = {
      async renderRegion(level: LevelInfo, px, py, w, h): Promise<RasterRegion> {
        const r = await call<Extract<FromWorker, { t: "region" }>>({ t: "region", scale: level.scale, px, py, w, h } as never);
        return {
          async encodeTile(sx, sy, tw, th) {
            const t = await call<Extract<FromWorker, { t: "tile" }>>({ t: "tile", region: r.region, sx, sy, w: tw, h: th } as never);
            return t.bytes;
          },
          release() {
            worker.postMessage({ t: "release", region: r.region } satisfies ToWorker);
          },
        };
      },
      cleanup() {
        worker.postMessage({ t: "cleanup" } satisfies ToWorker);
      },
    };
    return {
      pageWidth: info.pageWidth,
      pageHeight: info.pageHeight,
      pageCount: info.pageCount,
      backend,
      mode: "worker",
      async destroy() {
        try {
          await Promise.race([call({ t: "destroy" } as never), new Promise((r) => setTimeout(r, 5000))]);
        } finally {
          worker.terminate();
        }
      },
    };
  } catch (e) {
    worker.terminate();
    throw e;
  }
}

