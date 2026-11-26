import { createHash, randomBytes } from "node:crypto";
import { sha256OfChunks } from "./sha256Incremental";
import type { OfflineFiles } from "./types";
import type { PlanRows } from "./plan";

export const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
export const bytes = (n: number) => new Uint8Array(randomBytes(n));

export class FakeFiles implements OfflineFiles {
  parts = new Map<string, Uint8Array>();
  finals = new Map<string, Uint8Array>();
  /** url -> body served. */
  remote = new Map<string, Uint8Array>();
  free = Number.MAX_SAFE_INTEGER;
  requests: Array<{ url: string; offset: number }> = [];
  chunk = 1000;
  /** Called after every written chunk with the part size; may throw or abort. */
  afterChunk?: (key: string, size: number) => Promise<void> | void;
  awake: boolean[] = [];

  async partSize(key: string) {
    return this.parts.get(key)?.length ?? 0;
  }
  async size(key: string) {
    return this.finals.get(key)?.length ?? null;
  }
  async download(o: Parameters<OfflineFiles["download"]>[0]) {
    const body = this.remote.get(o.url);
    if (!body) throw new Error("HTTP 404");
    this.requests.push({ url: o.url, offset: o.offset });
    let part = (this.parts.get(o.key) ?? new Uint8Array(0)).slice(0, o.offset);
    for (let at = o.offset; at < body.length; at += this.chunk) {
      if (o.signal?.aborted) {
        this.parts.set(o.key, part);
        const e = new Error("aborted");
        e.name = "AbortError";
        throw e;
      }
      const next = body.subarray(at, Math.min(body.length, at + this.chunk));
      const merged = new Uint8Array(part.length + next.length);
      merged.set(part);
      merged.set(next, part.length);
      part = merged;
      this.parts.set(o.key, part);
      o.onProgress(part.length, body.length);
      await new Promise((r) => setTimeout(r, 0));
      await this.afterChunk?.(o.key, part.length);
    }
    return { bytes: part.length };
  }
  async hash(key: string, part: boolean) {
    const data = (part ? this.parts : this.finals).get(key);
    if (!data) throw new Error("not found");
    // Same path as production fallbacks: slices into the incremental hasher.
    async function* slices() {
      for (let o = 0; o < data!.length; o += 777) yield data!.subarray(o, o + 777);
    }
    return sha256OfChunks(slices());
  }
  async commit(key: string) {
    const p = this.parts.get(key);
    if (!p) throw new Error("no part");
    this.finals.set(key, p);
    this.parts.delete(key);
  }
  async move(from: string, to: string) {
    this.finals.set(to, this.finals.get(from)!);
    this.finals.delete(from);
  }
  async discardPart(key: string) {
    this.parts.delete(key);
  }
  async remove(key: string) {
    this.finals.delete(key);
  }
  async freeBytes() {
    return this.free;
  }
  async keepAwake(on: boolean) {
    this.awake.push(on);
  }
}

export interface Fixture {
  rows: PlanRows;
  frag: Uint8Array;
  pdf: Uint8Array;
}

export function makeRows(opts: { frag?: Uint8Array; pdf?: Uint8Array; fragVersion?: number; pdfVersion?: number } = {}): Fixture {
  const frag = opts.frag ?? bytes(5000);
  const pdf = opts.pdf ?? bytes(2500);
  const fv = opts.fragVersion ?? 1;
  const pv = opts.pdfVersion ?? 1;
  return {
    frag,
    pdf,
    rows: {
      ifcFiles: [{ id: "f1", buildingId: "b1", name: "Structure", currentVersionId: `iv${fv}`, createdAt: 1, updatedAt: 1 }],
      ifcVersions: [
        {
          id: `iv${fv}`,
          ifcFileId: "f1",
          versionNumber: fv,
          ifcFileSize: 10,
          contentHash: "x",
          fragBlobKey: `f1__v${fv}`,
          storeyCount: 1,
          createdAt: 1,
          isLatest: true,
          storagePath: "projects/p1/ifc/should-never-download.ifc",
          sha256: "0".repeat(64),
          sizeBytes: 10,
          contentType: "application/octet-stream",
          fragStoragePath: `projects/p1/frag/iv${fv}.frag`,
          fragSha256: sha(frag),
          fragSizeBytes: frag.length,
        },
      ],
      pdfFiles: [{ id: "p1", buildingId: "b1", name: "S-101", createdAt: 1, updatedAt: 1 }],
      pdfVersions: [
        {
          id: `pv${pv}`,
          pdfFileId: "p1",
          versionNumber: pv,
          name: "S-101.pdf",
          size: pdf.length,
          contentHash: "x",
          pageCount: 1,
          width: 100,
          height: 100,
          storedAt: 1,
          blobKey: `p1__v${pv}`,
          isLatest: true,
          storagePath: `projects/p1/pdf/pv${pv}.pdf`,
          sha256: sha(pdf),
          sizeBytes: pdf.length,
          contentType: "application/pdf",
        },
      ],
    },
  };
}

export function serve(files: FakeFiles, fx: Fixture) {
  for (const v of fx.rows.ifcVersions) if (v.fragStoragePath) files.remote.set(`https://dl/${v.fragStoragePath}`, fx.frag);
  for (const v of fx.rows.pdfVersions) files.remote.set(`https://dl/${v.storagePath}`, fx.pdf);
}
