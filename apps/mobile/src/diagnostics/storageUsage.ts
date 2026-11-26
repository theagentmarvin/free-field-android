import type { BlobStore } from "../storage";

export interface StorageUsage {
  blobBytes: number;
  blobCount: number;
  /** navigator.storage.estimate().usage (IndexedDB + caches), when available. */
  originUsage: number | null;
  originQuota: number | null;
}

export async function computeStorageUsage(
  blobs: BlobStore,
  storage: Pick<StorageManager, "estimate"> | undefined = typeof navigator === "undefined" ? undefined : navigator.storage,
): Promise<StorageUsage> {
  const list = await blobs.list();
  let originUsage: number | null = null;
  let originQuota: number | null = null;
  try {
    const est = await storage?.estimate?.();
    originUsage = est?.usage ?? null;
    originQuota = est?.quota ?? null;
  } catch {
    /* estimate unavailable */
  }
  return { blobBytes: list.reduce((n, b) => n + b.size, 0), blobCount: list.length, originUsage, originQuota };
}

export function formatBytes(n: number | null): string {
  if (n === null) return "n/a";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}
