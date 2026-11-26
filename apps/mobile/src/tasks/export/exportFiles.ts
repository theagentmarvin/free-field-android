import { Capacitor } from "@capacitor/core";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import { testHooksEnabled } from "../../dev/flag";
import { FfmFiles } from "../../storage/ffmFiles";
import type { ByteSink } from "./pdfWriter";

/**
 * Where exports are written and how they leave the device. A file is built in the app cache directory in chunks (never as one
 * big base64 string), then either handed to the Android share sheet or copied to the public Downloads folder.
 */

export const EXPORT_DIR = "exports";
export const MIME: Record<string, string> = {
  pdf: "application/pdf",
  csv: "text/csv",
  bcf: "application/octet-stream",
};

export interface ExportFile {
  name: string;
  mime: string;
  size: number;
  /** cache-relative path (native) */
  path: string | null;
  /** file:// uri for the share sheet (native) */
  uri: string | null;
  /** in-memory copy (browser fallback only) */
  blob: Blob | null;
}

export interface FileSink extends ByteSink {
  close(): Promise<ExportFile>;
  /** drop the partial file (cancel or failure) */
  abort(): Promise<void>;
}

export interface FileBackend {
  create(name: string, mime: string): Promise<FileSink>;
}

/** Bytes per bridge call. Base64 inflates by a third, so this keeps one call near 340 KB of string. */
export const WRITE_CHUNK = 256 * 1024;

/** Split bytes into at most `size` pieces (views, no copy). */
export function chunkBytes(bytes: Uint8Array, size = WRITE_CHUNK): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.byteLength; i += size) out.push(bytes.subarray(i, Math.min(bytes.byteLength, i + size)));
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.byteLength; i += step) s += String.fromCharCode(...bytes.subarray(i, i + step));
  return btoa(s);
}

/** Write a Blob through a sink one slice at a time (BCF zips). */
export async function pipeBlob(blob: Blob, sink: ByteSink, size = WRITE_CHUNK * 4): Promise<void> {
  for (let i = 0; i < blob.size; i += size) {
    const part = new Uint8Array(await blob.slice(i, Math.min(blob.size, i + size)).arrayBuffer());
    for (const c of chunkBytes(part)) await sink.write(c);
  }
}

/** Text through a sink in UTF-8 chunks. */
export async function pipeText(text: string, sink: ByteSink): Promise<void> {
  const bytes = new TextEncoder().encode(text);
  for (const c of chunkBytes(bytes)) await sink.write(c);
}

export function nativeBackend(): FileBackend {
  return {
    async create(name, mime) {
      const path = `${EXPORT_DIR}/${name}`;
      let started = false;
      let size = 0;
      return {
        async write(chunk) {
          if (chunk.byteLength === 0) return;
          const data = bytesToBase64(chunk);
          if (!started) {
            await Filesystem.writeFile({ path, data, directory: Directory.Cache, recursive: true });
            started = true;
          } else {
            await Filesystem.appendFile({ path, data, directory: Directory.Cache });
          }
          size += chunk.byteLength;
        },
        async close() {
          if (!started) await Filesystem.writeFile({ path, data: "", directory: Directory.Cache, recursive: true });
          const { uri } = await Filesystem.getUri({ path, directory: Directory.Cache });
          return { name, mime, size, path, uri, blob: null };
        },
        async abort() {
          await Filesystem.deleteFile({ path, directory: Directory.Cache }).catch(() => undefined);
        },
      };
    },
  };
}

/** Browser/dev fallback and unit tests: chunks collect in memory. */
export function memoryBackend(): FileBackend & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  return {
    files,
    async create(name, mime) {
      const parts: Uint8Array[] = [];
      let size = 0;
      return {
        async write(chunk) {
          parts.push(chunk.slice());
          size += chunk.byteLength;
        },
        async close() {
          const all = new Uint8Array(size);
          let o = 0;
          for (const p of parts) {
            all.set(p, o);
            o += p.byteLength;
          }
          files.set(name, all);
          return { name, mime, size, path: null, uri: null, blob: new Blob([all as BlobPart], { type: mime }) };
        },
        async abort() {
          parts.length = 0;
        },
      };
    },
  };
}

export const defaultBackend = (): FileBackend => (Capacitor.isNativePlatform() ? nativeBackend() : memoryBackend());

/** Old exports are removed so the cache does not grow; a file shared a moment ago is kept. */
export async function pruneExports(maxAgeMs = 60 * 60 * 1000, now = Date.now()): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  try {
    const { files } = await Filesystem.readdir({ path: EXPORT_DIR, directory: Directory.Cache });
    for (const f of files) {
      if (f.mtime && now - f.mtime > maxAgeMs) await Filesystem.deleteFile({ path: `${EXPORT_DIR}/${f.name}`, directory: Directory.Cache }).catch(() => undefined);
    }
  } catch {
    /* no exports folder yet */
  }
}

declare global {
  interface Window {
    /** e2e seam (test-hook builds only): what the export flow handed to the system. */
    __ffmExportLog?: { name: string; size: number; via: "share" | "downloads" | "download"; uri: string | null; at: number }[];
  }
}

function logDelivery(file: ExportFile, via: "share" | "downloads" | "download"): void {
  if (!testHooksEnabled()) return;
  (window.__ffmExportLog ??= []).push({ name: file.name, size: file.size, via, uri: file.uri, at: Date.now() });
}

/** The share promise only settles when the sheet closes; treat "still pending after the grace period" as shown. */
const SHARE_GRACE_MS = 1500;

export async function shareExport(file: ExportFile): Promise<boolean> {
  logDelivery(file, "share");
  if (Capacitor.isNativePlatform() && file.uri) {
    const { value } = await Share.canShare();
    if (!value) return false;
    const opened = Share.share({ title: file.name, dialogTitle: "Share export", files: [file.uri] }).then(() => true);
    opened.catch(() => undefined);
    return Promise.race([opened, new Promise<boolean>((r) => setTimeout(() => r(true), SHARE_GRACE_MS))]).catch(() => false);
  }
  const nav = navigator as Navigator & { canShare?: (d: unknown) => boolean };
  if (file.blob && nav.canShare && nav.share) {
    const f = new File([file.blob], file.name, { type: file.mime });
    if (nav.canShare({ files: [f] })) {
      await nav.share({ files: [f], title: file.name });
      return true;
    }
  }
  return downloadInBrowser(file);
}

export interface SavedCopy {
  name: string;
  /** human-readable place, e.g. "Downloads/..." */
  where: string;
}

export async function saveToDownloads(file: ExportFile): Promise<SavedCopy> {
  if (Capacitor.isNativePlatform() && file.path) {
    const res = await FfmFiles.saveToDownloads({ path: `${EXPORT_DIR}/${file.name}`, name: file.name, mime: file.mime });
    logDelivery(file, "downloads");
    return { name: res.name, where: res.where };
  }
  logDelivery(file, "download");
  downloadInBrowser(file);
  return { name: file.name, where: "Downloads" };
}

function downloadInBrowser(file: ExportFile): boolean {
  if (!file.blob || typeof document === "undefined") return false;
  const url = URL.createObjectURL(file.blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return true;
}
