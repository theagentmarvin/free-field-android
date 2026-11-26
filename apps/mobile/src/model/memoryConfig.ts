import type { MemoryTuning } from "@ff/viewer-react";
import { testHooksEnabled } from "../dev/flag";

const MB = 1024 * 1024;

/**
 * Engine memory settings for the phone / tablet viewer (the web viewer keeps the engine defaults). Chosen from the
 * measurements in docs/spikes/model-memory.md: see that file for why each value.
 */
export const MOBILE_MEMORY: MemoryTuning = {
  // Culls elements below ~10 px on screen (engine default is ~4 px); coming closer brings them back.
  graphicsQuality: -2,
  // Small / far items as line stand-ins instead of full triangles (the biggest single saving, see the doc).
  lodMode: "default",
  // No face-id colours (GPU) and one CPU copy of the index (renderer): mobile picks with the worker raycast.
  leanTiles: true,
  // Caps of the per-worker caches of invisible tiles and decoded meshes (the engine sizes them from screen / RAM).
  graphicBudgetBytes: 32 * MB,
  meshCacheBytes: 48 * MB,
  // One worker per model of the 3-model federation, not cores - 3.
  maxWorkers: 3,
};

/** Federation size (bytes of `.frag`) where the demo-sized settings end and the heavy ones are fully applied. */
const LIGHT_BYTES = 150 * MB;
const HEAVY_BYTES = 300 * MB;
/** Culling strength at the heavy end: elements under ~15 px at Fit are skipped (they come back when the camera moves closer). */
const HEAVY_QUALITY = -3.5;

/**
 * Settings scaled to the federation: the resident raw `.frag` bytes are a fixed cost, so the more models are open the
 * harder the engine culls small elements (the biggest lever on tile memory, docs/spikes/heavy-models.md) and the fewer
 * workers (each costs its own heap) share the parsing. The 3-model demo (~120 MB) keeps the values it was tuned with.
 */
export function tuningForBytes(totalBytes: number): MemoryTuning {
  const t = Math.min(1, Math.max(0, (totalBytes - LIGHT_BYTES) / (HEAVY_BYTES - LIGHT_BYTES)));
  return {
    ...MOBILE_MEMORY,
    graphicsQuality: (MOBILE_MEMORY.graphicsQuality ?? -2) + t * (HEAVY_QUALITY - (MOBILE_MEMORY.graphicsQuality ?? -2)),
    maxWorkers: totalBytes > 200 * MB ? 2 : MOBILE_MEMORY.maxWorkers,
  };
}

/** The tuning the viewer gets. Test builds can override it with localStorage `ffm.memCfg` (JSON) to run a configuration matrix. */
export function memoryTuning(totalBytes = 0): MemoryTuning {
  const base = tuningForBytes(totalBytes);
  if (testHooksEnabled()) {
    try {
      const raw = localStorage.getItem("ffm.memCfg");
      if (raw) return { ...base, ...(JSON.parse(raw) as MemoryTuning) };
    } catch {
      /* fall through to the defaults */
    }
  }
  return base;
}
