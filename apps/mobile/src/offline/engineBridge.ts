import { getDownloadURL, getMetadata, ref, type FirebaseStorage } from "firebase/storage";
import { Capacitor } from "@capacitor/core";
import type { BlobSink, BlobTransport } from "@ff/sync";
import type { SyncBlobKind } from "@ff/types";
import { getBlobStore } from "../storage";
import { sha256OfBlob } from "./sha256Incremental";
import { localUriForKey } from "./sources";
import type { DownloadUrl, OfflineFiles } from "./types";

const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_");
const keyFor = (kind: SyncBlobKind, key: string) => `${kind}/${safe(key)}.${kind}`;

/** Blobs the lazy path left on disk, so `put` can adopt the file instead of copying bytes. */
const adopted = new WeakMap<Blob, string>();

/** BlobSink writing into the app BlobStore (Capacitor Filesystem). Engine bytes already passed its checks. */
export function createMobileBlobSink(files: OfflineFiles): BlobSink {
  return {
    async has(kind, key) {
      if (kind === "ifc") return false; // never stored on mobile
      return (await files.size(keyFor(kind, key))) !== null;
    },
    async put(kind, key, blob) {
      if (kind === "ifc") return;
      const target = keyFor(kind, key);
      const from = adopted.get(blob);
      if (from) {
        await files.move(from, target); // streamed download: no bytes cross the JS heap
        return;
      }
      // Small blob handed over in memory (tests / tiny files): write through the store.
      await getBlobStore().write(target, new Uint8Array(await blob.arrayBuffer()));
    },
  };
}

/** Engine hasher that reads 4 MB slices (works on file-backed Blobs without loading them). */
export const chunkedHasher = (blob: Blob) => sha256OfBlob(blob);

export interface StreamingTransportDeps {
  files: OfflineFiles;
  storage: FirebaseStorage;
  urlFor(path: string): Promise<DownloadUrl>;
}

/**
 * Engine BlobTransport for mobile. Downloads stream to a file (HTTP Range, native); the returned Blob is read
 * back from that file through the WebView's file server, so the body never sits in the JS heap. The bulk path of
 * the download manager does not go through here (it has its own journal); this serves `fetchBlobByKey` lazy reads.
 * Mobile never uploads blobs (read-only for content).
 */
export function createStreamingTransport(deps: StreamingTransportDeps): BlobTransport {
  return {
    async head(path) {
      try {
        const m = await getMetadata(ref(deps.storage, path));
        return { sizeBytes: m.size, sha256: m.customMetadata?.sha256 };
      } catch (err) {
        if ((err as { code?: string }).code === "storage/object-not-found") return null;
        throw err;
      }
    },
    async upload() {
      throw new Error("mobile never uploads blobs (content is read-only)");
    },
    async download(path, opts) {
      const tmp = `lazy/${safe(path)}`;
      const target = await deps.urlFor(path);
      const offset = await deps.files.partSize(tmp);
      const ctl = new AbortController();
      opts?.signal?.addEventListener("abort", () => ctl.abort());
      await deps.files.download({
        id: `lazy:${path}`,
        url: target.url,
        headers: target.headers,
        key: tmp,
        offset,
        signal: ctl.signal,
        onProgress: (b, t) => opts?.onProgress?.(b, t),
      });
      await deps.files.commit(tmp);
      let blob: Blob;
      const uri = Capacitor.isNativePlatform() ? await localUriForKey(tmp) : null;
      if (uri) blob = await (await fetch(Capacitor.convertFileSrc(uri))).blob();
      else blob = new Blob([(await getBlobStore().read(tmp)) as BlobPart]);
      adopted.set(blob, tmp);
      return blob;
    },
  };
}

/** Storage URL for a path: the tokenised download URL (works without auth headers, native HTTP can fetch it). */
export function createUrlProvider(storage: FirebaseStorage) {
  return async (path: string): Promise<DownloadUrl> => ({ url: await getDownloadURL(ref(storage, path)) });
}
