import { describe, expect, it } from "vitest";
import { DEFAULT_OPACITY_PCT, DEFAULT_PREFS, normalizeOpacityPct, parsePrefs, planAlpha } from "./overlay";

describe("overlay prefs", () => {
  it("defaults to split, 60 %, plan touch", () => {
    expect(parsePrefs(null)).toEqual(DEFAULT_PREFS);
    expect(DEFAULT_PREFS).toEqual({ mode: "split", opacity: 60, touch: "plan" });
  });
  it("reads a saved choice and ignores junk", () => {
    expect(parsePrefs(JSON.stringify({ mode: "overlay", opacity: 35, touch: "3d" }))).toEqual({ mode: "overlay", opacity: 35, touch: "3d" });
    expect(parsePrefs("{nope")).toEqual(DEFAULT_PREFS);
    expect(parsePrefs(JSON.stringify({ mode: "weird", opacity: "x", touch: 5 }))).toEqual(DEFAULT_PREFS);
  });
  it("opacity is an integer percent, clamped; junk and empty fall back", () => {
    expect(normalizeOpacityPct(150)).toBe(100);
    expect(normalizeOpacityPct(-4)).toBe(0);
    expect(normalizeOpacityPct("42.6")).toBe(43);
    expect(normalizeOpacityPct("")).toBe(DEFAULT_OPACITY_PCT);
    expect(normalizeOpacityPct(null)).toBe(DEFAULT_OPACITY_PCT);
    expect(normalizeOpacityPct(NaN)).toBe(DEFAULT_OPACITY_PCT);
    expect(normalizeOpacityPct(0)).toBe(0);
  });
  it("the plan is only translucent in overlay mode", () => {
    expect(planAlpha({ mode: "split", opacity: 20 })).toBe(1);
    expect(planAlpha({ mode: "overlay", opacity: 20 })).toBe(0.2);
  });
});
