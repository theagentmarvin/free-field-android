import { describe, expect, it } from "vitest";
import { fitWithin, nextQuality } from "./imageMath";

describe("downscale math", () => {
  it("never upscales", () => expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 }));
  it("caps the long edge at 2560 keeping aspect", () => {
    expect(fitWithin(4000, 3000)).toEqual({ width: 2560, height: 1920 });
    expect(fitWithin(3000, 4000)).toEqual({ width: 1920, height: 2560 });
    expect(fitWithin(2560, 2560)).toEqual({ width: 2560, height: 2560 });
  });
  it("keeps at least one pixel", () => expect(fitWithin(100000, 10, 2560).height).toBe(1));
  it("rejects bad sizes", () => expect(() => fitWithin(0, 5)).toThrow(RangeError));
  it("quality steps down to a floor", () => {
    expect(nextQuality(0.8)).toBe(0.65);
    expect(nextQuality(0.45)).toBe(0.4);
  });
});
