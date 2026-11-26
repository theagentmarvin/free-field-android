/// <reference lib="webworker" />
// Tile worker: pdf.js + OffscreenCanvas + WebP encoding off the main thread. The PDF is read in ranges
// through the main thread (only it can reach the native plugin), so the worker never holds a second copy.
import "./workerShim";
import { openWithPdfjs, type CoreOpened } from "./pdfCore";
import type { RasterRegion } from "./tileRenderer";
import type { FromWorker, ToWorker } from "./pdfWorkerProtocol";

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const post = (m: FromWorker, transfer: Transferable[] = []) => ctx.postMessage(m, transfer);

let opened: CoreOpened | null = null;
const regions = new Map<number, RasterRegion>();
let regionSeq = 0;
const pendingRanges = new Map<number, { resolve(d: Uint8Array): void; reject(e: Error): void }>();
let rangeSeq = 0;

function readRange(begin: number, end: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const rid = ++rangeSeq;
    pendingRanges.set(rid, { resolve, reject });
    post({ t: "range", rid, begin, end });
  });
}

ctx.onmessage = async (ev: MessageEvent<ToWorker>) => {
  const m = ev.data;
  try {
    switch (m.t) {
      case "open": {
        const input = m.bytes
          ? ({ kind: "bytes", bytes: m.bytes } as const)
          : ({ kind: "ranged", length: m.length, readRange } as const);
        opened = await openWithPdfjs(input, { quality: m.quality, assetBase: m.assetBase, inWorker: true });
        post({ t: "opened", id: m.id, pageWidth: opened.pageWidth, pageHeight: opened.pageHeight, pageCount: opened.pageCount });
        break;
      }
      case "rangeData":
        pendingRanges.get(m.rid)?.resolve(m.data);
        pendingRanges.delete(m.rid);
        break;
      case "rangeError":
        pendingRanges.get(m.rid)?.reject(new Error(m.message));
        pendingRanges.delete(m.rid);
        break;
      case "region": {
        if (!opened) throw new Error("not open");
        const r = await opened.backend.renderRegion(
          { z: 0, scale: m.scale, width: 0, height: 0, cols: 0, rows: 0 },
          m.px,
          m.py,
          m.w,
          m.h,
        );
        const region = ++regionSeq;
        regions.set(region, r);
        post({ t: "region", id: m.id, region });
        break;
      }
      case "tile": {
        const r = regions.get(m.region);
        if (!r) throw new Error("unknown region");
        const bytes = await r.encodeTile(m.sx, m.sy, m.w, m.h);
        post({ t: "tile", id: m.id, bytes }, [bytes.buffer]);
        break;
      }
      case "release":
        regions.get(m.region)?.release();
        regions.delete(m.region);
        break;
      case "cleanup":
        opened?.backend.cleanup?.();
        break;
      case "destroy":
        for (const r of regions.values()) r.release();
        regions.clear();
        await opened?.destroy();
        opened = null;
        post({ t: "destroyed", id: m.id });
        break;
    }
  } catch (e) {
    post({ t: "error", id: "id" in m ? m.id : 0, message: String((e as Error)?.message ?? e) });
  }
};

post({ t: "ready" });
