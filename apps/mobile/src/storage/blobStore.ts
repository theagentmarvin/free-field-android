/**
 * BlobStore: where blobs larger than ~1 MB live (models, PDFs, tiles, photos).
 * IndexedDB only holds metadata (SPEC A3). Keys are flat, URL-safe ids such as
 * `frag/<versionId>.frag`; "/" segments map to directories.
 */

export interface BlobStat {
  key: string;
  /** Size in bytes. */
  size: number;
  /** Last modification time (epoch ms) when the backend reports it. */
  mtime?: number;
}

export interface WriteOptions {
  /** Expected lowercase hex sha256 of the bytes. A mismatch rejects the write and leaves no file behind. */
  sha256?: string;
}

export interface ReadOptions {
  /** When set the bytes are hashed after reading; a mismatch throws {@link BlobIntegrityError}. */
  verifySha256?: string;
}

export interface BlobStore {
  /** Atomically write `data` under `key` (temp file + rename). Returns the sha256 of the stored bytes. */
  write(key: string, data: Uint8Array, opts?: WriteOptions): Promise<string>;
  /** Read the bytes, or `null` when the key does not exist. */
  read(key: string, opts?: ReadOptions): Promise<Uint8Array | null>;
  /**
   * Read `length` bytes starting at `offset` without loading the whole file (the PDF reader uses it for
   * ranged access to big plans). Fewer bytes come back at the end of the file; `null` when the key is
   * missing. Optional: callers fall back to `read` when a store does not provide it.
   */
  readRange?(key: string, offset: number, length: number): Promise<Uint8Array | null>;
  /** Stat a key, or `null` when it does not exist. */
  stat(key: string): Promise<BlobStat | null>;
  /** Delete a key. Resolves `false` when it did not exist. */
  delete(key: string): Promise<boolean>;
  /** List keys under a prefix (default: everything). Temp files are never listed. */
  list(prefix?: string): Promise<BlobStat[]>;
}

export class BlobIntegrityError extends Error {
  constructor(
    public readonly key: string,
    public readonly expected: string,
    public readonly actual: string,
  ) {
    super(`sha256 mismatch for ${key}: expected ${expected}, got ${actual}`);
    this.name = "BlobIntegrityError";
  }
}

export class InvalidBlobKeyError extends Error {
  constructor(key: string) {
    super(`invalid blob key: ${JSON.stringify(key)}`);
    this.name = "InvalidBlobKeyError";
  }
}

/** Suffix of in-flight temp files; never visible through `list`/`read`. */
export const TMP_SUFFIX = ".part";

const KEY_RE = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

/** Reject traversal, absolute paths, empty segments and our own temp suffix. */
export function assertValidKey(key: string): void {
  if (!KEY_RE.test(key) || key.split("/").some((s) => s === "." || s === "..") || key.endsWith(TMP_SUFFIX)) {
    throw new InvalidBlobKeyError(key);
  }
}
