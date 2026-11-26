import { describe, expect, it } from "vitest";
import { MemoryBlobStore } from "../storage";
import { RANGE_MAX_READ, readRangeChunked } from "./pdfInput";
import { LocalPlanSource, RANGED_MIN_BYTES, pdfKey } from "./planSource";

const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => i % 251);

describe("readRangeChunked", () => {
  it("joins pieces of at most RANGE_MAX_READ and stops at the end of the file", async () => {
    const file = bytes(RANGE_MAX_READ * 2 + 1000);
    const asked: number[] = [];
    const read = async (o: number, l: number) => {
      asked.push(l);
      return file.slice(o, o + l);
    };
    const out = await readRangeChunked(read, 10, file.length + 5000); // end beyond EOF
    expect(out.length).toBe(file.length - 10);
    expect(out[0]).toBe(file[10]);
    expect(out[out.length - 1]).toBe(file[file.length - 1]);
    expect(Math.max(...asked)).toBeLessThanOrEqual(RANGE_MAX_READ);
    expect((await readRangeChunked(read, 5, 5)).length).toBe(0);
  });
  it("returns what it has when the file ends early or vanishes", async () => {
    expect((await readRangeChunked(async () => null, 0, 100)).length).toBe(0);
  });
});

describe("LocalPlanSource", () => {
  const ref = { planVersionId: "v1", pdfFileId: "f", blobKey: "k1", name: "P" };
  it("reads the PDF from the BlobStore and never fetches", async () => {
    const store = new MemoryBlobStore();
    await store.write(pdfKey(ref), bytes(100));
    expect(await new LocalPlanSource(store).fetchPdf(ref)).toEqual(bytes(100));
    await expect(new LocalPlanSource(store).fetchPdf({ ...ref, blobKey: "missing" })).rejects.toThrow(/not on this device/);
  });
  it("offers ranged access only for big files (or when forced)", async () => {
    const store = new MemoryBlobStore();
    await store.write(pdfKey(ref), bytes(1000));
    const src = new LocalPlanSource(store);
    expect(await src.openRanged(ref)).toBeNull();
    const forced = await src.openRanged(ref, { force: true });
    expect(forced?.kind === "ranged" && forced.length).toBe(1000);
    if (forced?.kind === "ranged") expect(await forced.readRange(990, 2000)).toEqual(bytes(1000).slice(990));
    await store.write(pdfKey({ blobKey: "big" }), bytes(RANGED_MIN_BYTES));
    const big = await src.openRanged({ ...ref, blobKey: "big" });
    expect(big?.kind).toBe("ranged");
  });
});
