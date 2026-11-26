import { Capacitor } from "@capacitor/core";
import type { BlobStore } from "./blobStore";
import { CapacitorBlobStore } from "./capacitorBlobStore";
import { FfmFiles } from "./ffmFiles";
import { base64ToBytes } from "./base64";
import { MemoryBlobStore } from "./memoryBlobStore";

export * from "./blobStore";
export { CapacitorBlobStore } from "./capacitorBlobStore";
export { MemoryBlobStore } from "./memoryBlobStore";
export { sha256Hex } from "./sha256";

let store: BlobStore | null = null;

/** App-wide BlobStore: Filesystem on device, in-memory in a plain browser. */
export function getBlobStore(): BlobStore {
  if (!store) store = Capacitor.isNativePlatform() ? new CapacitorBlobStore({
          rangeReader: async (path, offset, length) => {
            try {
              return base64ToBytes((await FfmFiles.readRange({ path, offset, length })).data);
            } catch (e) {
              if (/not.?found|no such file/i.test(String((e as Error)?.message ?? e))) return null;
              throw e;
            }
          },
        }) : new MemoryBlobStore();
  return store;
}
