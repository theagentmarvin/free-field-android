export type ItemKind = "frag" | "pdf";
export type ItemStatus = "queued" | "downloading" | "verifying" | "done" | "paused" | "error";
export type ErrorKind = "network" | "integrity" | "http" | "storage" | "other";

/** One downloadable file of a building, as derived from the synced metadata. */
export interface PlanItem {
  id: string; // `${kind}:${versionId}`
  kind: ItemKind;
  fileId: string; // ifcFileId / pdfFileId
  fileName: string;
  versionId: string;
  versionNumber: number;
  storagePath: string;
  sha256: string;
  size: number;
  /** BlobStore key of the finished file, e.g. `frag/<fragBlobKey>.frag`. */
  key: string;
}

/** Journal row (Dexie `ffm-offline`): the persistent state of one item, enough to resume after a kill. */
export interface OfflineItem extends PlanItem {
  projectId: string;
  buildingId: string;
  status: ItemStatus;
  bytesDone: number;
  error?: string;
  errorKind?: ErrorKind;
  updatedAt: number;
}

export type PausedBy = "user" | "network" | null;

export interface OfflinePackage {
  buildingId: string;
  projectId: string;
  name: string;
  pausedBy: PausedBy;
  /** True once a newer version than the downloaded one was seen. */
  updateAvailable: boolean;
  createdAt: number;
  updatedAt: number;
}

export type PackageState = "none" | "downloading" | "paused" | "error" | "ready" | "update-available";

export interface PackageSummary {
  state: PackageState;
  doneBytes: number;
  totalBytes: number;
  doneItems: number;
  totalItems: number;
  errorItems: number;
  fraction: number;
}

export type RefusalCode = "low-storage" | "wifi-only" | "offline" | "nothing-to-download" | "no-backend";

export class OfflineRefusal extends Error {
  constructor(
    readonly code: RefusalCode,
    message: string,
  ) {
    super(message);
    this.name = "OfflineRefusal";
  }
}

export class IntegrityError extends Error {
  constructor(detail: string) {
    super(`Integrity check failed: ${detail}`);
    this.name = "IntegrityError";
  }
}

/** File operations the manager needs. Native impl: ./nativeFiles.ts. Keys are BlobStore keys. */
export interface OfflineFiles {
  /** Bytes of the partial file for `key` (0 when none). */
  partSize(key: string): Promise<number>;
  /** Size of the finished file, or null. */
  size(key: string): Promise<number | null>;
  /**
   * Stream `url` into the partial file of `key`, appending from `offset` (HTTP Range). Never holds the body
   * in JS memory. Rejects with an AbortError when `signal` aborts.
   */
  download(opts: {
    id: string;
    url: string;
    headers?: Record<string, string>;
    key: string;
    offset: number;
    onProgress(bytes: number, total: number): void;
    signal?: AbortSignal;
  }): Promise<{ bytes: number }>;
  /** Incremental sha256 + size of the partial file (or the finished one when `part` is false). */
  hash(key: string, part: boolean): Promise<{ sha256: string; size: number }>;
  /** Atomic rename of the partial file to the final key. */
  commit(key: string): Promise<void>;
  /** Rename a finished file to another key (used by the lazy engine path). */
  move(from: string, to: string): Promise<void>;
  discardPart(key: string): Promise<void>;
  remove(key: string): Promise<void>;
  /** Free bytes on the volume holding app data. */
  freeBytes(): Promise<number>;
  keepAwake?(on: boolean): Promise<void>;
}

export interface DownloadUrl {
  url: string;
  headers?: Record<string, string>;
}

export interface NetworkInfo {
  online: boolean;
  connectionType: string;
}

export interface OfflineSettings {
  wifiOnly: boolean;
  autoUpdate: boolean;
}

/** Info handed to the plan renderer when a PDF finished downloading (docs/integration/plans-offline.md). */
export interface PlanDownloadedEvent {
  projectId: string;
  buildingId: string;
  pdfFileId: string;
  versionId: string;
  versionNumber: number;
  key: string;
  sha256: string;
  size: number;
}
