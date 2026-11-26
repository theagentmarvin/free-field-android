import { Directory, Filesystem } from "@capacitor/filesystem";
import { base64ToBytes, bytesToBase64 } from "./base64";
import {
  assertValidKey,
  BlobIntegrityError,
  TMP_SUFFIX,
  type BlobStat,
  type BlobStore,
  type ReadOptions,
  type WriteOptions,
} from "./blobStore";
import { sha256Hex } from "./sha256";

/** The subset of the Filesystem plugin API we use (lets tests inject a fake). */
export type FsApi = Pick<
  typeof Filesystem,
  "writeFile" | "readFile" | "stat" | "deleteFile" | "readdir" | "rename" | "mkdir"
>;

/** Native ranged read: bytes at [offset, offset + length) of a file under `directory`, or null when missing. */
export type RangeReader = (path: string, offset: number, length: number) => Promise<Uint8Array | null>;

export interface CapacitorBlobStoreOptions {
  fs?: FsApi;
  /** Ranged reader; defaults to the native FfmFiles plugin. Without one `readRange` is not offered. */
  rangeReader?: RangeReader;
  directory?: Directory;
  /** Root folder inside the directory. */
  root?: string;
}

const isNotFound = (e: unknown) => /not exist|not found|no such file|does not exist/i.test(String((e as Error)?.message ?? e));

/**
 * BlobStore on Capacitor Filesystem (`Directory.Data`, app-private storage).
 * Writes go to `<key>.part` and are renamed into place only after the sha256
 * check, so a kill mid-write never leaves a half file under a real key.
 */
export class CapacitorBlobStore implements BlobStore {
  private readonly fs: FsApi;
  private readonly directory: Directory;
  private readonly root: string;
  readonly readRange?: (key: string, offset: number, length: number) => Promise<Uint8Array | null>;

  constructor(opts: CapacitorBlobStoreOptions = {}) {
    this.fs = opts.fs ?? Filesystem;
    this.directory = opts.directory ?? Directory.Data;
    this.root = opts.root ?? "blobs";
    const reader = opts.rangeReader;
    if (reader) {
      this.readRange = async (key, offset, length) => {
        assertValidKey(key);
        return reader(this.path(key), offset, length);
      };
    }
  }

  private path(key: string): string {
    return `${this.root}/${key}`;
  }

  async write(key: string, data: Uint8Array, opts?: WriteOptions): Promise<string> {
    assertValidKey(key);
    const actual = await sha256Hex(data);
    if (opts?.sha256 && opts.sha256 !== actual) throw new BlobIntegrityError(key, opts.sha256, actual);
    const finalPath = this.path(key);
    const tmpPath = finalPath + TMP_SUFFIX;
    try {
      await this.fs.writeFile({
        path: tmpPath,
        directory: this.directory,
        data: bytesToBase64(data),
        recursive: true,
      });
      const mv = () =>
        this.fs.rename({ from: tmpPath, to: finalPath, directory: this.directory, toDirectory: this.directory });
      try {
        await mv();
      } catch (first) {
        // Some platforms refuse to rename onto an existing file. Move the old
        // value aside (hidden .part name), swap, and restore it if the swap fails.
        const existing = await this.stat(key);
        if (!existing) throw first;
        const aside = finalPath + ".old" + TMP_SUFFIX;
        await this.fs.rename({ from: finalPath, to: aside, directory: this.directory, toDirectory: this.directory });
        try {
          await mv();
        } catch (second) {
          await this.fs
            .rename({ from: aside, to: finalPath, directory: this.directory, toDirectory: this.directory })
            .catch(() => undefined);
          throw second;
        }
        await this.fs.deleteFile({ path: aside, directory: this.directory }).catch(() => undefined);
      }
    } catch (e) {
      await this.fs.deleteFile({ path: tmpPath, directory: this.directory }).catch(() => undefined);
      throw e;
    }
    return actual;
  }

  async read(key: string, opts?: ReadOptions): Promise<Uint8Array | null> {
    assertValidKey(key);
    let bytes: Uint8Array;
    try {
      const res = await this.fs.readFile({ path: this.path(key), directory: this.directory });
      bytes =
        typeof res.data === "string" ? base64ToBytes(res.data) : new Uint8Array(await (res.data as Blob).arrayBuffer());
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
    if (opts?.verifySha256) {
      const actual = await sha256Hex(bytes);
      if (actual !== opts.verifySha256) throw new BlobIntegrityError(key, opts.verifySha256, actual);
    }
    return bytes;
  }

  async stat(key: string): Promise<BlobStat | null> {
    assertValidKey(key);
    try {
      const s = await this.fs.stat({ path: this.path(key), directory: this.directory });
      return { key, size: s.size, mtime: s.mtime };
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }

  async delete(key: string): Promise<boolean> {
    assertValidKey(key);
    try {
      await this.fs.deleteFile({ path: this.path(key), directory: this.directory });
      return true;
    } catch (e) {
      if (isNotFound(e)) return false;
      throw e;
    }
  }

  async list(prefix = ""): Promise<BlobStat[]> {
    const out: BlobStat[] = [];
    const walk = async (rel: string): Promise<void> => {
      let entries;
      try {
        entries = await this.fs.readdir({ path: rel ? `${this.root}/${rel}` : this.root, directory: this.directory });
      } catch (e) {
        if (isNotFound(e)) return;
        throw e;
      }
      for (const f of entries.files) {
        const key = rel ? `${rel}/${f.name}` : f.name;
        if (f.type === "directory") await walk(key);
        else if (!key.endsWith(TMP_SUFFIX) && key.startsWith(prefix)) out.push({ key, size: f.size, mtime: f.mtime });
      }
    };
    await walk("");
    return out.sort((a, b) => a.key.localeCompare(b.key));
  }
}
