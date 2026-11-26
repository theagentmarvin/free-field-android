import {
  assertValidKey,
  BlobIntegrityError,
  type BlobStat,
  type BlobStore,
  type ReadOptions,
  type WriteOptions,
} from "./blobStore";
import { sha256Hex } from "./sha256";

/** In-memory BlobStore for tests and non-native (browser dev) runs. */
export class MemoryBlobStore implements BlobStore {
  private files = new Map<string, { data: Uint8Array; mtime: number }>();

  async write(key: string, data: Uint8Array, opts?: WriteOptions): Promise<string> {
    assertValidKey(key);
    const actual = await sha256Hex(data);
    if (opts?.sha256 && opts.sha256 !== actual) throw new BlobIntegrityError(key, opts.sha256, actual);
    this.files.set(key, { data: data.slice(), mtime: Date.now() });
    return actual;
  }

  async read(key: string, opts?: ReadOptions): Promise<Uint8Array | null> {
    assertValidKey(key);
    const f = this.files.get(key);
    if (!f) return null;
    if (opts?.verifySha256) {
      const actual = await sha256Hex(f.data);
      if (actual !== opts.verifySha256) throw new BlobIntegrityError(key, opts.verifySha256, actual);
    }
    return f.data.slice();
  }

  async readRange(key: string, offset: number, length: number): Promise<Uint8Array | null> {
    assertValidKey(key);
    const f = this.files.get(key);
    return f ? f.data.slice(offset, offset + length) : null;
  }

  async stat(key: string): Promise<BlobStat | null> {
    assertValidKey(key);
    const f = this.files.get(key);
    return f ? { key, size: f.data.length, mtime: f.mtime } : null;
  }

  async delete(key: string): Promise<boolean> {
    assertValidKey(key);
    return this.files.delete(key);
  }

  async list(prefix = ""): Promise<BlobStat[]> {
    return [...this.files.entries()]
      .filter(([k]) => k.startsWith(prefix))
      .map(([key, f]) => ({ key, size: f.data.length, mtime: f.mtime }))
      .sort((a, b) => a.key.localeCompare(b.key));
  }
}
