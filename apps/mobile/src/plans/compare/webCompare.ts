// The web Documents "compare revisions" engine, reused as is (pure TypeScript, no web UI): the diff job with
// its worker client, the sensitivity presets, the region finder and the misalignment hint. Only the raster
// source differs on the tablet: rasters come from the tile pyramid instead of live pdf.js renders.
// Relative imports like measure/webMath.ts: the vendored sources are read-only.
export { runDiff, type RunDiffOptions } from "../../../../../vendor/free-field/apps/documents/src/compare/engine/diffClient";
export type { DiffJobInput, DiffJobOutput } from "../../../../../vendor/free-field/apps/documents/src/compare/engine/diffJob";
export { runDiffJob } from "../../../../../vendor/free-field/apps/documents/src/compare/engine/diffJob";
export { resolveThresholds, PRESET_VALUES } from "../../../../../vendor/free-field/apps/documents/src/compare/engine/presets";
export { looksMisaligned, MISALIGNED_MESSAGE } from "../../../../../vendor/free-field/apps/documents/src/compare/hints";
export { cloudPath } from "../../../../../vendor/free-field/apps/documents/src/compare/cloudPath";
export { DEFAULT_COMPARE_SETTINGS } from "../../../../../vendor/free-field/apps/documents/src/compare/types";
export type { ChangeKind, ChangeRegion, DiffThresholds, PtBox, RasterPage } from "../../../../../vendor/free-field/apps/documents/src/compare/types";
export type { CompareResult } from "../../../../../vendor/free-field/apps/documents/src/compare/types";
