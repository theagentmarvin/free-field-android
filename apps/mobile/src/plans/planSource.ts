import { isDemoAuth } from "@ff/auth";
import { readRangeChunked, type PdfInput } from "./pdfInput";
import { getBlobStore, sha256Hex, type BlobStore } from "../storage";

/** The slice of a plan version the plans feature needs (decoupled from Dexie rows). */
export interface PlanVersionRef {
  planVersionId: string;
  pdfFileId: string;
  /** Storage key of the PDF (PdfVersionRecord.blobKey). */
  blobKey: string;
  name: string;
  /** sha256 of the PDF when the sync layer already verified it (saves hashing the file again). */
  sha256?: string;
}

/**
 * Where plan PDFs come from. The sync/download layer will provide the real
 * implementation (Storage download into the BlobStore); the demo one serves
 * bundled samples. Implementations must leave the bytes in the BlobStore under
 * `pdfKey(ref)` so a re-render never needs the network again.
 */
export interface PlanSource {
  fetchPdf(ref: PlanVersionRef, signal?: AbortSignal): Promise<Uint8Array>;
  /**
   * Optional ranged access to the PDF for big files (no whole-file buffer on the JS heap). Resolves null when
   * the file is small or the store cannot do ranged reads; the caller then uses `fetchPdf`.
   */
  openRanged?(ref: PlanVersionRef, opts?: { force?: boolean }): Promise<PdfInput | null>;
}

/** PDFs at or above this size are read in ranges (below it one buffer is cheaper than many bridge calls). */
export const RANGED_MIN_BYTES = 4 * 1024 * 1024;

export const pdfKey = (ref: Pick<PlanVersionRef, "blobKey">) => `pdf/${ref.blobKey}.pdf`;

/** Demo source: BlobStore first, then the bundled `/samples/plans/<blobKey>.pdf`. */
export class DemoPlanSource implements PlanSource {
  constructor(
    private readonly store: BlobStore = getBlobStore(),
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
  ) {}

  async fetchPdf(ref: PlanVersionRef, signal?: AbortSignal): Promise<Uint8Array> {
    const key = pdfKey(ref);
    const have = await this.store.read(key);
    if (have) return have;
    const res = await this.fetchImpl(`/samples/plans/${ref.blobKey}.pdf`, { signal });
    if (!res.ok) throw new Error(`plan ${ref.name} is not available offline (HTTP ${res.status})`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    await this.store.write(key, bytes, { sha256: await sha256Hex(bytes) });
    return bytes;
  }

  /** Plans already in the BlobStore (pushed by tests, or fetched before) can be read in ranges too. */
  async openRanged(ref: PlanVersionRef, opts: { force?: boolean } = {}): Promise<PdfInput | null> {
    return (await openRangedFromStore(this.store, ref, opts)) ?? null;
  }
}

/** Ranged reader over a BlobStore key; null = small file or no ranged reads; undefined = key missing. */
async function openRangedFromStore(store: BlobStore, ref: PlanVersionRef, opts: { force?: boolean }): Promise<PdfInput | null | undefined> {
  if (!store.readRange) return null;
  const key = pdfKey(ref);
  const st = await store.stat(key);
  if (!st) return undefined;
  if (!opts.force && st.size < RANGED_MIN_BYTES) return null;
  return {
    kind: "ranged",
    length: st.size,
    readRange: (begin, end) => readRangeChunked((o, l) => store.readRange!(key, o, l), begin, Math.min(end, st.size)),
  };
}

/**
 * Cloud source: the offline layer already put the PDF into the BlobStore (`pdf/<blobKey>.pdf`, verified
 * by sha256), so this only reads it. It never touches the network.
 */
export class LocalPlanSource implements PlanSource {
  constructor(private readonly store: BlobStore = getBlobStore()) {}

  async fetchPdf(ref: PlanVersionRef): Promise<Uint8Array> {
    const have = await this.store.read(pdfKey(ref));
    if (!have) throw new Error(`plan ${ref.name} is not on this device; make its building available offline first`);
    return have;
  }

  async openRanged(ref: PlanVersionRef, opts: { force?: boolean } = {}): Promise<PdfInput | null> {
    const input = await openRangedFromStore(this.store, ref, opts);
    if (input === undefined) throw new Error(`plan ${ref.name} is not on this device; make its building available offline first`);
    return input;
  }
}

let current: PlanSource | null = null;
export function getPlanSource(): PlanSource {
  return (current ??= isDemoAuth() ? new DemoPlanSource() : new LocalPlanSource());
}
/** Swap the source (the sync layer installs its own; tests inject fakes). */
export function setPlanSource(s: PlanSource | null): void {
  current = s;
}
