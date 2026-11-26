import type { IfcFileRecord, IfcVersionRecord, PdfFileRecord, PdfVersionRecord, PdfFolderRecord, PdfFolderAssignmentRecord, StoreyRecord } from "@ff/types";
import { Directory, Filesystem } from "@capacitor/filesystem";
import type { OfflineDb } from "./journal";
import type { OfflineItem, PlanDownloadedEvent } from "./types";

// ── onPlanDownloaded hook point ───────────────────────────────

type PlanHook = (e: PlanDownloadedEvent) => void | Promise<void>;
const planHooks = new Set<PlanHook>();

/** Register a listener (e.g. the tile renderer) called after each PDF is verified and in place. Returns unsubscribe. */
export function onPlanDownloaded(hook: PlanHook): () => void {
  planHooks.add(hook);
  return () => planHooks.delete(hook);
}

/** Called by the download manager. A hook that throws never fails the download. */
export function emitPlanDownloaded(e: PlanDownloadedEvent): void {
  for (const h of planHooks) {
    try {
      void Promise.resolve(h(e)).catch((err) => console.warn("[offline] onPlanDownloaded hook failed", err));
    } catch (err) {
      console.warn("[offline] onPlanDownloaded hook failed", err);
    }
  }
}

// ── local file locations ──────────────────────────────────────

/** Path of a finished file relative to Capacitor `Directory.Data` (the BlobStore root is `blobs/`). */
export const localPathForKey = (key: string) => `blobs/${key}`;

export async function localUriForKey(key: string): Promise<string | null> {
  try {
    return (await Filesystem.getUri({ path: localPathForKey(key), directory: Directory.Data })).uri;
  } catch {
    return null;
  }
}

// ── DownloadedPlanSource ──────────────────────────────────────

export interface DownloadedPdfVersion {
  version: PdfVersionRecord;
  /** BlobStore key of the downloaded PDF, or null when this version is not on the device. */
  localKey: string | null;
  /** Path relative to Directory.Data (`blobs/pdf/<versionId>.pdf`), or null. */
  localPath: string | null;
}

export interface DownloadedPlan {
  file: PdfFileRecord;
  /** Newest version that is on the device (the one to display). */
  downloaded: DownloadedPdfVersion | null;
  /** Every synced revision, newest first, each with its local key (null = not on the device). */
  versions: DownloadedPdfVersion[];
  folderId: string | null;
}

/**
 * Everything the Plans tab needs from the offline layer: the synced Dexie rows (pdfFiles, pdfVersions,
 * storeys, folders, folder assignments) plus the local path of each downloaded PDF. Read-only.
 */
export class DownloadedPlanSource {
  constructor(
    private deps: {
      journal: OfflineDb;
      rows: {
        pdfFiles(buildingId: string): Promise<PdfFileRecord[]>;
        pdfVersions(pdfFileIds: string[]): Promise<PdfVersionRecord[]>;
        storeys(buildingId: string): Promise<StoreyRecord[]>;
        folders(projectId: string): Promise<PdfFolderRecord[]>;
        folderAssignments(pdfFileIds: string[]): Promise<PdfFolderAssignmentRecord[]>;
      };
    },
  ) {}

  private async doneKeys(buildingId: string): Promise<Map<string, OfflineItem>> {
    const items = await this.deps.journal.items.where("buildingId").equals(buildingId).filter((i) => i.kind === "pdf" && i.status === "done").toArray();
    return new Map(items.map((i) => [i.versionId, i]));
  }

  async listPlans(buildingId: string): Promise<DownloadedPlan[]> {
    const files = await this.deps.rows.pdfFiles(buildingId);
    const ids = files.map((f) => f.id);
    const [versions, assignments, done] = await Promise.all([
      this.deps.rows.pdfVersions(ids),
      this.deps.rows.folderAssignments(ids),
      this.doneKeys(buildingId),
    ]);
    return files.map((file) => {
      const mine = versions.filter((v) => v.pdfFileId === file.id).sort((a, b) => b.versionNumber - a.versionNumber);
      const hit = mine.find((v) => done.has(v.id));
      const asDownloaded = (v: PdfVersionRecord): DownloadedPdfVersion => {
        const it = done.get(v.id);
        return { version: v, localKey: it?.key ?? null, localPath: it ? localPathForKey(it.key) : null };
      };
      return {
        file,
        versions: mine.map(asDownloaded),
        downloaded: hit
          ? { version: hit, localKey: done.get(hit.id)!.key, localPath: localPathForKey(done.get(hit.id)!.key) }
          : null,
        folderId: assignments.find((a) => a.pdfFileId === file.id)?.folderId ?? null,
      };
    });
  }

  storeys(buildingId: string): Promise<StoreyRecord[]> {
    return this.deps.rows.storeys(buildingId);
  }

  folders(projectId: string): Promise<PdfFolderRecord[]> {
    return this.deps.rows.folders(projectId);
  }

  /** Local key of one downloaded PDF version (null when absent). */
  async localKeyForVersion(buildingId: string, versionId: string): Promise<string | null> {
    return (await this.doneKeys(buildingId)).get(versionId)?.key ?? null;
  }
}

// ── DownloadedModelSource ─────────────────────────────────────

export interface DownloadedModel {
  file: IfcFileRecord;
  version: IfcVersionRecord;
  /** BlobStore key `frag/<fragBlobKey>.frag` (readable with `getBlobStore().read(key)`). */
  localKey: string;
  localPath: string;
}

/** The downloaded `.frag` files of a building, for the Model tab. IFC never exists on the device. */
export class DownloadedModelSource {
  constructor(
    private deps: {
      journal: OfflineDb;
      ifcFiles(buildingId: string): Promise<IfcFileRecord[]>;
      ifcVersion(versionId: string): Promise<IfcVersionRecord | undefined>;
    },
  ) {}

  async list(buildingId: string): Promise<DownloadedModel[]> {
    const items = await this.deps.journal.items.where("buildingId").equals(buildingId).filter((i) => i.kind === "frag" && i.status === "done").toArray();
    const files = await this.deps.ifcFiles(buildingId);
    const out: DownloadedModel[] = [];
    for (const it of items) {
      const file = files.find((f) => f.id === it.fileId);
      const version = await this.deps.ifcVersion(it.versionId);
      if (file && version) out.push({ file, version, localKey: it.key, localPath: localPathForKey(it.key) });
    }
    return out;
  }

  /** BlobStore key of the building's (first) downloaded model, or null when it is not offline. */
  async getLocalFragKey(buildingId: string): Promise<string | null> {
    return (await this.list(buildingId))[0]?.localKey ?? null;
  }

  /** `file://`-style URI of the downloaded model, or null. */
  async getLocalFragPath(buildingId: string): Promise<string | null> {
    const key = await this.getLocalFragKey(buildingId);
    return key ? localUriForKey(key) : null;
  }
}
