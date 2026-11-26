import { planLevels, TILE_SIZE, type LevelInfo, type PyramidOptions } from "./tileMath";

/** On-disk description of a rendered plan version (`tiles/{planVersionId}/manifest.json`). */
export interface PlanManifest {
  v: 1;
  planVersionId: string;
  /** sha256 (hex) of the source PDF bytes; a different hash invalidates every tile. */
  sha256: string;
  page: number;
  /** Page size in PDF points (rotation applied). */
  pageWidth: number;
  pageHeight: number;
  tileSize: number;
  format: "webp";
  levels: LevelInfo[];
  /** False while rendering or after a cancel/crash: tiles may be missing. */
  complete: boolean;
  createdAt: number;
  /** Wall time of the last full render, when known. */
  renderMs?: number;
}

export const tilePrefix = (planVersionId: string) => `tiles/${planVersionId}/`;
export const manifestKey = (planVersionId: string) => `${tilePrefix(planVersionId)}manifest.json`;
/** Whole-page overview image (not a tile; lives under the tile prefix so every cleanup that drops the tiles drops it too). */
export const previewKey = (planVersionId: string) => `${tilePrefix(planVersionId)}preview.img`;
export const tileKey = (planVersionId: string, z: number, x: number, y: number) =>
  `${tilePrefix(planVersionId)}${z}/${x}_${y}.webp`;

export function buildManifest(
  planVersionId: string,
  sha256: string,
  pageWidth: number,
  pageHeight: number,
  opts?: PyramidOptions,
  now = Date.now(),
): PlanManifest {
  return {
    v: 1,
    planVersionId,
    sha256,
    page: 1,
    pageWidth,
    pageHeight,
    tileSize: TILE_SIZE,
    format: "webp",
    levels: planLevels(pageWidth, pageHeight, opts),
    complete: false,
    createdAt: now,
  };
}

export function serializeManifest(m: PlanManifest): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(m));
}

/** Parse and validate; returns null for anything that is not a usable v1 manifest. */
export function parseManifest(bytes: Uint8Array | null): PlanManifest | null {
  if (!bytes) return null;
  try {
    const m = JSON.parse(new TextDecoder().decode(bytes)) as Partial<PlanManifest>;
    if (m.v !== 1 || m.format !== "webp" || m.tileSize !== TILE_SIZE) return null;
    if (typeof m.planVersionId !== "string" || typeof m.sha256 !== "string") return null;
    if (!(m.pageWidth! > 0) || !(m.pageHeight! > 0) || !Array.isArray(m.levels) || m.levels.length === 0) return null;
    for (const l of m.levels) {
      if (!(l.scale > 0) || !(l.cols > 0) || !(l.rows > 0)) return null;
    }
    return m as PlanManifest;
  } catch {
    return null;
  }
}

/** Same page, same hash, same level layout: existing tiles may be reused. */
export function sameLayout(a: PlanManifest, b: PlanManifest): boolean {
  return (
    a.sha256 === b.sha256 &&
    a.pageWidth === b.pageWidth &&
    a.pageHeight === b.pageHeight &&
    a.levels.length === b.levels.length &&
    a.levels.every((l, i) => l.width === b.levels[i].width && l.height === b.levels[i].height)
  );
}
