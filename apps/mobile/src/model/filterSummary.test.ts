import { describe, expect, it } from "vitest";
import { filterItems, filtersLabel, splitItems, type FilterView } from "./filterSummary";

const none: FilterView = { level: null, cut: false, modelsTotal: 3, modelsVisible: 3, categoriesHidden: 0, isolated: false, xray: false, elementsHidden: false };

describe("filterItems", () => {
  it("is empty when nothing is filtered", () => expect(filterItems(none)).toEqual([]));
  it("names the level, with the cut", () => {
    expect(filterItems({ ...none, level: "101 FIRST FLOOR" })).toEqual([{ kind: "level", label: "101 FIRST FLOOR" }]);
    expect(filterItems({ ...none, level: "101 FIRST FLOOR", cut: true })[0].label).toBe("101 FIRST FLOOR · cut");
  });
  it("a cut without a level is not a filter", () => expect(filterItems({ ...none, cut: true })).toEqual([]));
  it("counts models and categories", () => {
    expect(filterItems({ ...none, modelsVisible: 2 })).toEqual([{ kind: "models", label: "2 of 3 models" }]);
    expect(filterItems({ ...none, modelsVisible: 0 })[0].label).toBe("0 of 3 models");
    expect(filterItems({ ...none, categoriesHidden: 1 })[0].label).toBe("1 category hidden");
    expect(filterItems({ ...none, categoriesHidden: 4 })[0].label).toBe("4 categories hidden");
  });
  it("a single model cannot be 'filtered' by model", () => expect(filterItems({ ...none, modelsTotal: 1, modelsVisible: 0 })).toEqual([]));
  it("lists isolate, hidden elements and x-ray after the rest", () => {
    const k = filterItems({ ...none, level: "L1", modelsVisible: 1, isolated: true, xray: true, elementsHidden: true }).map((i) => i.kind);
    expect(k).toEqual(["level", "models", "isolate", "hidden", "xray"]);
  });
});

describe("splitItems / filtersLabel", () => {
  it("shows two chips and counts the rest", () => {
    expect(splitItems([1, 2, 3, 4])).toEqual({ shown: [1, 2], more: 2 });
    expect(splitItems([1, 2])).toEqual({ shown: [1, 2], more: 0 });
    expect(splitItems([])).toEqual({ shown: [], more: 0 });
  });
  it("labels the button with the count", () => {
    expect(filtersLabel(0)).toBe("Filters");
    expect(filtersLabel(2)).toBe("Filters · 2");
  });
});
