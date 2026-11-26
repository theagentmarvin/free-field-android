import { describe, expect, it } from "vitest";
import { encodeJpegUnder, MAX_CAPTURE_BYTES, QUALITY_STEPS, type CanvasLike } from "./encode";

/** A canvas whose encode size depends on the quality (like a JPEG). */
const fake = (bytesAt: (q: number) => number | null): { canvas: CanvasLike; asked: number[] } => {
  const asked: number[] = [];
  return {
    asked,
    canvas: {
      toBlob(cb, _type, q = 1) {
        asked.push(q);
        const n = bytesAt(q);
        cb(n === null ? null : new Blob([new Uint8Array(n)], { type: "image/jpeg" }));
      },
    },
  };
};

describe("encodeJpegUnder", () => {
  it("keeps the first quality that fits", async () => {
    const { canvas, asked } = fake(() => 1000);
    const b = await encodeJpegUnder(canvas, 5000);
    expect(b.size).toBe(1000);
    expect(asked).toEqual([QUALITY_STEPS[0]]);
  });
  it("steps the quality down until it fits", async () => {
    const { canvas, asked } = fake((q) => Math.round(q * 2_000_000));
    const b = await encodeJpegUnder(canvas);
    expect(b.size).toBeLessThanOrEqual(MAX_CAPTURE_BYTES);
    expect(asked.length).toBeGreaterThan(1);
    expect(asked).toEqual([...asked].sort((a, c) => c - a));
  });
  it("returns the smallest attempt when nothing fits", async () => {
    const { canvas, asked } = fake((q) => Math.round(q * 9_000_000));
    const b = await encodeJpegUnder(canvas, 100);
    expect(asked).toEqual([...QUALITY_STEPS]);
    expect(b.size).toBe(Math.round(QUALITY_STEPS[QUALITY_STEPS.length - 1] * 9_000_000));
  });
  it("throws when the canvas cannot encode", async () => {
    const { canvas } = fake(() => null);
    await expect(encodeJpegUnder(canvas)).rejects.toThrow(/encode/);
  });
  it("targets about 1.5 MB", () => {
    expect(MAX_CAPTURE_BYTES).toBe(1.5 * 1024 * 1024);
  });
});
