/**
 * Where the PDF bytes come from. Small files travel as one buffer; big ones are read in ranges
 * (pdf.js `PDFDataRangeTransport`) straight from the BlobStore so the JS heap never holds a second copy.
 */
export type PdfInput =
  | { kind: "bytes"; bytes: Uint8Array }
  | {
      kind: "ranged";
      /** File size in bytes. */
      length: number;
      /** Bytes [begin, end) of the file (fewer at the end of the file). */
      readRange(begin: number, end: number): Promise<Uint8Array>;
    };

/** First chunk handed to pdf.js together with the length (header; the rest is pulled on demand). */
export const RANGE_INITIAL_BYTES = 64 * 1024;
/** Preferred range size for pdf.js requests: fewer bridge round trips than its 64 KB default. */
export const RANGE_CHUNK_BYTES = 1024 * 1024;
/** One native read never asks for more than this (the plugin caps at 8 MB). */
export const RANGE_MAX_READ = 4 * 1024 * 1024;

/** Read [begin, end) in pieces of at most RANGE_MAX_READ and join them. */
export async function readRangeChunked(
  read: (offset: number, length: number) => Promise<Uint8Array | null>,
  begin: number,
  end: number,
): Promise<Uint8Array> {
  const out = new Uint8Array(Math.max(0, end - begin));
  let at = 0;
  while (at < out.length) {
    const want = Math.min(RANGE_MAX_READ, out.length - at);
    const part = await read(begin + at, want);
    if (!part || part.length === 0) return out.subarray(0, at);
    out.set(part, at);
    at += part.length;
    if (part.length < want) return out.subarray(0, at);
  }
  return out;
}
