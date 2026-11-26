import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Sha256, sha256OfBlob, sha256OfChunks } from "./sha256Incremental";

const ref = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

describe("incremental sha256", () => {
  it("matches the reference for known vectors", () => {
    expect(new Sha256().digestHex()).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(new Sha256().update(new TextEncoder().encode("abc")).digestHex()).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("matches the reference around block boundaries for any chunking", () => {
    for (const n of [0, 1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000, 70001]) {
      const data = new Uint8Array(randomBytes(n));
      for (const step of [1, 7, 64, 100, 4096]) {
        const h = new Sha256();
        for (let o = 0; o < n; o += step) h.update(data.subarray(o, Math.min(n, o + step)));
        expect(h.digestHex(), `n=${n} step=${step}`).toBe(ref(data));
      }
    }
  });

  it("hashes an async chunk stream and a Blob without concatenating", async () => {
    const data = new Uint8Array(randomBytes(300_000));
    async function* chunks() {
      for (let o = 0; o < data.length; o += 65536) yield data.subarray(o, o + 65536);
    }
    const r = await sha256OfChunks(chunks());
    expect(r).toEqual({ sha256: ref(data), size: data.length });
    expect(await sha256OfBlob(new Blob([data]), 50_000)).toBe(ref(data));
  });

  it("refuses updates after the digest", () => {
    const h = new Sha256();
    h.digestHex();
    expect(() => h.update(new Uint8Array(1))).toThrow();
  });
});
