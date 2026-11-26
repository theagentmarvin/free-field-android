// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { EMPTY_PREFS, isEmptyPrefs, loadPrefs, parsePrefs, prefsKey, sanitizePrefs, savePrefs } from "./filterPrefs";

beforeEach(() => window.localStorage.clear());

describe("parsePrefs", () => {
  it("reads what save wrote and ignores garbage", () => {
    savePrefs("b1", { level: "L1", cut: true, hiddenModels: ["m1"], hiddenCategories: ["IFCWALL"] });
    expect(loadPrefs("b1")).toEqual({ level: "L1", cut: true, hiddenModels: ["m1"], hiddenCategories: ["IFCWALL"] });
    expect(parsePrefs("not json")).toEqual(EMPTY_PREFS);
    expect(parsePrefs(null)).toEqual(EMPTY_PREFS);
    expect(parsePrefs('{"level":3,"hiddenModels":"x","hiddenCategories":[1,"A"]}')).toEqual({ level: null, cut: false, hiddenModels: [], hiddenCategories: ["A"] });
  });
  it("is remembered per building and cleared when empty", () => {
    savePrefs("b1", { ...EMPTY_PREFS, level: "L1" });
    expect(loadPrefs("b2")).toEqual(EMPTY_PREFS);
    savePrefs("b1", EMPTY_PREFS);
    expect(window.localStorage.getItem(prefsKey("b1"))).toBeNull();
    expect(isEmptyPrefs(loadPrefs("b1"))).toBe(true);
  });
});

describe("sanitizePrefs", () => {
  it("drops what no longer exists and a cut without a level", () => {
    const p = { level: "GONE", cut: true, hiddenModels: ["m1", "mX"], hiddenCategories: ["IFCWALL"] };
    expect(sanitizePrefs(p, { levels: ["L1"], models: ["m1"] })).toEqual({ level: null, cut: false, hiddenModels: ["m1"], hiddenCategories: ["IFCWALL"] });
    expect(sanitizePrefs({ ...p, level: "L1" }, { levels: ["L1"], models: ["m1"] }).cut).toBe(true);
  });
});
