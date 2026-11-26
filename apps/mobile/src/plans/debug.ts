import { getBlobStore } from "../storage";
import { parseManifest, manifestKey, tileKey } from "./manifest";
import { pdfKey } from "./planSource";
import { tilePageRect } from "./tileMath";
import { getTileService, LEGACY_TUNING, type RenderStats, type RenderTuning } from "./tileService";

declare global {
  interface Window {
    /** Probe for e2e/perf runs (installed only when VITE_FFM_TEST_HOOKS=true): render a PDF already placed in the BlobStore and report timings. */
    __ffmPlans?: {
      renderStored(blobKey: string, planVersionId: string, tuning?: RenderTuning | "legacy"): Promise<RenderStats | null>;
      hasPdf(blobKey: string): Promise<boolean>;
      tileCount(planVersionId: string): Promise<number>;
      heapMb(): number | null;
      /** Renders started since the app launched. */
      renderRuns(): number;
      /** PNG data URL of a page rectangle (in points) drawn from the finest tiles, like the viewer at max zoom. */
      cropPng(planVersionId: string, rect: { x: number; y: number; w: number; h: number }, outWidth: number): Promise<string | null>;
      /** Stats (incl. timing marks) of the last finished render. */
      lastStats(): RenderStats | null;
      /** Manifest summary of a rendered version (levels, finest scale, complete). */
      manifestInfo(planVersionId: string): Promise<{ levels: number; finestScale: number; complete: boolean; pageWidth: number; pageHeight: number } | null>;
    };
  }
}

/** Installed once at startup, only when VITE_FFM_TEST_HOOKS=true (see dev/flag.ts). */
export function installPlanDebugHook(): void {
  window.__ffmPlans = {
    async hasPdf(blobKey) {
      return (await getBlobStore().stat(pdfKey({ blobKey }))) !== null;
    },
    async renderStored(blobKey, planVersionId, tuning) {
      const svc = getTileService();
      await svc.ensureTiles({ planVersionId, pdfFileId: "debug", blobKey, name: blobKey }, tuning === "legacy" ? LEGACY_TUNING : tuning);
      return svc.lastStats;
    },
    async tileCount(planVersionId) {
      return (await getBlobStore().list(`tiles/${planVersionId}/`)).filter((s) => s.key.endsWith(".webp")).length;
    },
    heapMb() {
      const m = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
      return m ? Math.round(m.usedJSHeapSize / 1048576) : null;
    },
    lastStats() {
      return getTileService().lastStats;
    },
    renderRuns() {
      return getTileService().runs;
    },
    async manifestInfo(planVersionId) {
      const m = parseManifest(await getBlobStore().read(manifestKey(planVersionId)));
      return m ? { levels: m.levels.length, finestScale: m.levels[m.levels.length - 1].scale, complete: m.complete, pageWidth: m.pageWidth, pageHeight: m.pageHeight } : null;
    },
    async cropPng(planVersionId, rect, outWidth) {
      const store = getBlobStore();
      const m = parseManifest(await store.read(manifestKey(planVersionId)));
      if (!m) return null;
      const level = m.levels[m.levels.length - 1];
      const k = outWidth / rect.w;
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(outWidth);
      canvas.height = Math.round(rect.h * k);
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      for (let y = 0; y < level.rows; y++) {
        for (let x = 0; x < level.cols; x++) {
          const r = tilePageRect(level, x, y);
          if (r.x + r.w < rect.x || r.x > rect.x + rect.w || r.y + r.h < rect.y || r.y > rect.y + rect.h) continue;
          const bytes = await store.read(tileKey(planVersionId, level.z, x, y));
          if (!bytes) continue;
          const bmp = await createImageBitmap(new Blob([bytes], { type: "image/webp" }));
          ctx.drawImage(bmp, (r.x - rect.x) * k, (r.y - rect.y) * k, r.w * k + 0.5, r.h * k + 0.5);
          bmp.close();
        }
      }
      return canvas.toDataURL("image/png");
    },
  };
}
