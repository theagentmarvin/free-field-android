import { Capacitor, type PluginListenerHandle } from "@capacitor/core";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { assertValidKey, TMP_SUFFIX } from "../storage/blobStore";
import { Sha256 } from "./sha256Incremental";
import type { OfflineFiles } from "./types";

export { FfmFiles, type FfmFilesPlugin } from "../storage/ffmFiles";
import { FfmFiles, type FfmFilesPlugin } from "../storage/ffmFiles";

const ROOT = "blobs"; // same root as CapacitorBlobStore
const finalPath = (key: string) => `${ROOT}/${key}`;
const partPath = (key: string) => `${ROOT}/${key}${TMP_SUFFIX}`;

const notFound = (e: unknown) => /not exist|not found|no such file|does not exist|not-found/i.test(String((e as Error)?.message ?? e));

async function statSize(path: string): Promise<number | null> {
  try {
    return (await Filesystem.stat({ path, directory: Directory.Data })).size;
  } catch (e) {
    if (notFound(e)) return null;
    throw e;
  }
}

/** Real OfflineFiles: native HTTP-to-file with Range resume, native incremental sha256, atomic rename. */
export function createNativeFiles(plugin: FfmFilesPlugin = FfmFiles): OfflineFiles {
  const progress = new Map<string, (bytes: number, total: number) => void>();
  let listener: Promise<PluginListenerHandle> | null = null;
  const ensureListener = () => (listener ??= plugin.addListener("progress", (e) => progress.get(e.id)?.(e.bytes, e.total)));

  return {
    async partSize(key) {
      assertValidKey(key);
      return (await statSize(partPath(key))) ?? 0;
    },
    async size(key) {
      assertValidKey(key);
      return statSize(finalPath(key));
    },
    async download({ id, url, headers, key, offset, onProgress, signal }) {
      assertValidKey(key);
      await ensureListener();
      progress.set(id, onProgress);
      const onAbort = () => void plugin.cancel({ id }).catch(() => undefined);
      signal?.addEventListener("abort", onAbort);
      try {
        const res = await plugin.download({ id, url, headers, path: partPath(key), offset });
        return { bytes: res.bytes };
      } catch (e) {
        if (signal?.aborted || /cancelled/i.test(String((e as Error)?.message))) {
          const err = new Error("aborted");
          err.name = "AbortError";
          throw err;
        }
        throw e;
      } finally {
        signal?.removeEventListener("abort", onAbort);
        progress.delete(id);
      }
    },
    async hash(key, part) {
      assertValidKey(key);
      return plugin.hashFile({ path: part ? partPath(key) : finalPath(key) });
    },
    async commit(key) {
      assertValidKey(key);
      if ((await statSize(finalPath(key))) !== null) await Filesystem.deleteFile({ path: finalPath(key), directory: Directory.Data });
      await Filesystem.rename({ from: partPath(key), to: finalPath(key), directory: Directory.Data, toDirectory: Directory.Data });
    },
    async move(from, to) {
      assertValidKey(from);
      assertValidKey(to);
      if ((await statSize(finalPath(to))) !== null) await Filesystem.deleteFile({ path: finalPath(to), directory: Directory.Data });
      await Filesystem.rename({ from: finalPath(from), to: finalPath(to), directory: Directory.Data, toDirectory: Directory.Data });
    },
    async discardPart(key) {
      assertValidKey(key);
      await Filesystem.deleteFile({ path: partPath(key), directory: Directory.Data }).catch((e) => {
        if (!notFound(e)) throw e;
      });
    },
    async remove(key) {
      assertValidKey(key);
      await Filesystem.deleteFile({ path: finalPath(key), directory: Directory.Data }).catch((e) => {
        if (!notFound(e)) throw e;
      });
    },
    async freeBytes() {
      if (Capacitor.isNativePlatform()) return (await plugin.freeSpace()).free;
      const est = await navigator.storage?.estimate?.();
      return est?.quota !== undefined ? est.quota - (est.usage ?? 0) : Number.MAX_SAFE_INTEGER;
    },
    async keepAwake(on) {
      if (Capacitor.isNativePlatform()) await plugin.keepAwake({ on }).catch(() => undefined);
    },
  };
}

/** Hash a file in JS from slices read through `readSlice` (fallback where no native hasher exists). */
export async function hashWithSlices(
  size: number,
  readSlice: (offset: number, length: number) => Promise<Uint8Array>,
  chunk = 4 * 1024 * 1024,
): Promise<{ sha256: string; size: number }> {
  const h = new Sha256();
  for (let o = 0; o < size; o += chunk) h.update(await readSlice(o, Math.min(chunk, size - o)));
  return { sha256: h.digestHex(), size };
}
