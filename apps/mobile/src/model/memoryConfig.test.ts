import { describe, expect, it } from "vitest";
import { MOBILE_MEMORY, tuningForBytes } from "./memoryConfig";

const MB = 1024 * 1024;

describe("tuningForBytes", () => {
  it("keeps the demo settings for a demo-sized federation", () => {
    expect(tuningForBytes(120 * MB)).toEqual(MOBILE_MEMORY);
    expect(tuningForBytes(0)).toEqual(MOBILE_MEMORY);
  });
  it("culls harder and uses fewer workers for a heavy one", () => {
    const t = tuningForBytes(474 * MB);
    expect(t.graphicsQuality).toBe(-3.5);
    expect(t.maxWorkers).toBe(2);
  });
  it("scales in between", () => {
    const q = tuningForBytes(225 * MB).graphicsQuality!;
    expect(q).toBeLessThan(-2);
    expect(q).toBeGreaterThan(-3.5);
  });
});
