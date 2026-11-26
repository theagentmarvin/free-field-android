import type { BlobStore } from "../storage";

/**
 * Key prefixes that hold re-creatable data only (plan tiles, temp downloads).
 * Offline packages (models, PDFs) and photos waiting for upload are NOT cache.
 */
export const CACHE_PREFIXES = ["tiles/", "cache/", "tmp/"] as const;

export async function clearCache(blobs: BlobStore, prefixes: readonly string[] = CACHE_PREFIXES): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  for (const prefix of prefixes) {
    for (const entry of await blobs.list(prefix)) {
      if (await blobs.delete(entry.key)) {
        files += 1;
        bytes += entry.size;
      }
    }
  }
  return { files, bytes };
}
