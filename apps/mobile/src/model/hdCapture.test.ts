import { describe, expect, it } from "vitest";
import { captureSize, hdPixelRatio, HD_LONG_SIDE } from "./hdCapture";

describe("hdPixelRatio", () => {
  it("asks for 2x on a tablet-sized stage", () => {
    expect(hdPixelRatio(1280, 720, 1)).toBe(1.875); // 2400 / 1280: long side capped
    expect(hdPixelRatio(1000, 600, 1)).toBe(2);
  });
  it("never goes under the ratio the viewer already uses", () => {
    expect(hdPixelRatio(2000, 1200, 1.5)).toBe(1.5); // cap 1.2 < current
    expect(hdPixelRatio(800, 480, 2.5)).toBe(2.5);
  });
  it("keeps the long side within the HD cap", () => {
    for (const [w, h] of [[1280, 800], [800, 1280], [1920, 1080], [412, 915]] as const) {
      const r = hdPixelRatio(w, h, 1);
      expect(Math.max(w, h) * r).toBeLessThanOrEqual(Math.max(HD_LONG_SIDE, Math.max(w, h)) + 1e-6);
    }
  });
  it("returns the current ratio for an empty stage", () => {
    expect(hdPixelRatio(0, 0, 1.25)).toBe(1.25);
  });
});

describe("captureSize", () => {
  it("rounds to whole pixels and is at least 1", () => {
    expect(captureSize(1000, 600, 2)).toEqual({ width: 2000, height: 1200 });
    expect(captureSize(333, 111, 1.5)).toEqual({ width: 500, height: 167 });
    expect(captureSize(0, 0, 2)).toEqual({ width: 1, height: 1 });
  });
});
