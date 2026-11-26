import type { PdfVersionRecord } from "@ff/types";
import type { BlobStore } from "../storage";
import type { DownloadedPlan } from "../offline/sources";
import type { PlanDownloadedEvent } from "../offline/types";
import { tilePrefix } from "./manifest";
import type { PlanVersionRef } from "./planSource";
import type { TileState } from "./tileService";

/**
 * Glue between the offline layer and the tile renderer (docs/integration/plans-offline.md):
 *  - `onDownloaded`: a PDF version finished downloading -> render its tiles when it is the newest revision of
 *    its plan. Older revisions are on the device too (the package carries every revision, for the history
 *    and compare views) and are tiled lazily when the user opens or compares them.
 *  - `reconcile`: at start / after journal changes -> render tiles that are missing for the newest downloaded
 *    revision of each plan and drop tiles of versions that are no longer on the device (removed packages)
 * Pure with injected dependencies, so it is unit-tested with fakes.
 */
export interface TileSyncDeps {
  tiles: {
    ensureTiles(ref: PlanVersionRef): Promise<unknown>;
    status(planVersionId: string): Promise<TileState>;
  };
  store: Pick<BlobStore, "list" | "delete">;
  /** Plans of a building as the offline layer sees them. */
  listPlans(buildingId: string): Promise<DownloadedPlan[]>;
  /** Display name of a plan file (for logs/refs); may return undefined. */
  planName?(pdfFileId: string): Promise<string | undefined>;
  /** Every synced version id of a plan file (downloaded or not). */
  versionIds(pdfFileId: string): Promise<string[]>;
  /** True when `versionId` is the newest synced revision of the plan. Absent: every download is rendered. */
  isNewest?(pdfFileId: string, versionId: string): Promise<boolean>;
  log?(msg: string): void;
}

/** `pdf/<blobKey>.pdf` -> `<blobKey>` */
export function blobKeyOfPdfKey(key: string): string {
  return key.replace(/^pdf\//, "").replace(/\.pdf$/, "");
}

export function refFromEvent(e: PlanDownloadedEvent, name?: string): PlanVersionRef {
  return { planVersionId: e.versionId, pdfFileId: e.pdfFileId, blobKey: blobKeyOfPdfKey(e.key), name: name ?? e.pdfFileId, sha256: e.sha256 };
}

export function refFromDownloaded(p: DownloadedPlan): PlanVersionRef | null {
  const d = p.downloaded;
  if (!d) return null;
  return { planVersionId: d.version.id, pdfFileId: p.file.id, blobKey: d.version.blobKey, name: p.file.name, sha256: d.version.sha256 ?? undefined };
}

async function dropTiles(deps: TileSyncDeps, versionId: string): Promise<number> {
  const stats = await deps.store.list(tilePrefix(versionId));
  for (const s of stats) await deps.store.delete(s.key);
  return stats.length;
}

export class PlanTileSync {
  constructor(private readonly deps: TileSyncDeps) {}

  /** The PDF was verified and is in place: render the tiles when it is the newest revision (older ones are tiled on demand). */
  async onDownloaded(e: PlanDownloadedEvent): Promise<void> {
    if (this.deps.isNewest && !(await this.deps.isNewest(e.pdfFileId, e.versionId))) return;
    const name = await this.deps.planName?.(e.pdfFileId).catch(() => undefined);
    await this.deps.tiles.ensureTiles(refFromEvent(e, name));
  }

  /**
   * Make the tiles match what is on the device: tiles of every revision that is no longer on the device are dropped, the newest
   * downloaded revision is rendered when it has no (complete) tiles. Renders run one at a time inside the tile service; this
   * resolves when all of them are done. A render that failed earlier is not retried here (no retry loops).
   */
  async reconcile(buildingIds: readonly string[]): Promise<void> {
    for (const buildingId of buildingIds) {
      const plans = await this.deps.listPlans(buildingId);
      for (const p of plans) {
        const onDevice = new Set(p.versions.filter((v) => v.localKey).map((v) => v.version.id));
        for (const id of await this.deps.versionIds(p.file.id)) if (!onDevice.has(id)) await dropTiles(this.deps, id);
        const ref = refFromDownloaded(p);
        if (!ref) continue;
        const st = await this.deps.tiles.status(ref.planVersionId);
        if (st.state === "none" || st.state === "partial") {
          await this.deps.tiles.ensureTiles(ref).catch((err: unknown) => this.deps.log?.(`tiles for ${p.file.name} failed: ${String(err)}`));
        }
      }
    }
  }
}

/** Version ids a pdfVersions row set resolves to (helper for the Dexie-backed `versionIds`). */
export const idsOf = (rows: readonly Pick<PdfVersionRecord, "id">[]): string[] => rows.map((r) => r.id);
