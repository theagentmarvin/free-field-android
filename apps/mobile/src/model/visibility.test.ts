import { describe, expect, it } from "vitest";
import { computeHidden, ghostSolid, groupVisibility, idsOf, INITIAL_VIS, isFiltered, planApply, visReduce, type Hidden, type Universe, type VisState } from "./visibility";

const uni = (n = 10): Universe => ({
  all: new Set(Array.from({ length: n }, (_, i) => i + 1)),
  categories: new Map([
    ["IFCWALL", [1, 2, 3]],
    ["IFCDOOR", [4, 5]],
    ["IFCSLAB", [6, 7, 8, 9, 10]],
  ]),
});
const hidden = (s: VisState, m = "a", u = uni()) => computeHidden(s, m, u);
const ids = (h: Hidden) => [...h.ids].sort((a, b) => a - b);

describe("layers", () => {
  it("starts with nothing hidden", () => {
    expect(hidden(INITIAL_VIS)).toEqual({ all: false, ids: new Set() });
    expect(isFiltered(INITIAL_VIS)).toBe(false);
  });

  it("a hidden model hides all of its elements and no other model's", () => {
    const s = visReduce(INITIAL_VIS, { t: "model", modelId: "a", visible: false });
    expect(hidden(s, "a").all).toBe(true);
    expect(hidden(s, "b").all).toBe(false);
    expect(visReduce(s, { t: "model", modelId: "a", visible: true }).hiddenModels.size).toBe(0);
  });

  it("category toggles hide and restore the class", () => {
    let s = visReduce(INITIAL_VIS, { t: "category", name: "IFCDOOR", visible: false });
    s = visReduce(s, { t: "category", name: "IFCWALL", visible: false });
    expect(ids(hidden(s))).toEqual([1, 2, 3, 4, 5]);
    s = visReduce(s, { t: "category", name: "IFCWALL", visible: true });
    expect(ids(hidden(s))).toEqual([4, 5]);
  });

  it("hide selection and unhide", () => {
    let s = visReduce(INITIAL_VIS, { t: "hide", ids: idsOf("a", [2, 3]) });
    expect(ids(hidden(s))).toEqual([2, 3]);
    s = visReduce(s, { t: "show", ids: idsOf("a", [2]) });
    expect(ids(hidden(s))).toEqual([3]);
  });

  it("isolate shows exactly the selection and drops earlier element hides", () => {
    let s = visReduce(INITIAL_VIS, { t: "hide", ids: idsOf("a", [9]) });
    s = visReduce(s, { t: "isolate", ids: idsOf("a", [1, 2]) });
    expect(ids(hidden(s))).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
    // a model without isolated ids hides everything it has
    expect(hidden(s, "b").ids.size).toBe(10);
    expect(isFiltered(s)).toBe(true);
  });

  it("categories still apply on top of an isolation", () => {
    let s = visReduce(INITIAL_VIS, { t: "isolate", ids: idsOf("a", [1, 4]) });
    s = visReduce(s, { t: "category", name: "IFCWALL", visible: false });
    expect(hidden(s).ids.has(1)).toBe(true);
    expect(hidden(s).ids.has(4)).toBe(false);
  });

  it("forcing an element on beats an isolation, a storey and a hidden category", () => {
    let s = visReduce(INITIAL_VIS, { t: "isolate", ids: idsOf("a", [1]) });
    s = visReduce(s, { t: "category", name: "IFCDOOR", visible: false });
    s = visReduce(s, { t: "show", ids: idsOf("a", [4, 6]) });
    const h = hidden(s);
    expect(h.ids.has(4)).toBe(false);
    expect(h.ids.has(6)).toBe(false);
    expect(h.ids.has(5)).toBe(true);
  });

  it("hiding wins over an earlier force", () => {
    let s = visReduce(INITIAL_VIS, { t: "show", ids: idsOf("a", [3]) });
    s = visReduce(s, { t: "hide", ids: idsOf("a", [3]) });
    expect(hidden(s).ids.has(3)).toBe(true);
  });

  it("a storey replaces an isolation (and vice versa); clearing it restores", () => {
    let s = visReduce(INITIAL_VIS, { t: "isolate", ids: idsOf("a", [1]) });
    s = visReduce(s, { t: "storey", keep: idsOf("a", [6, 7]) });
    expect(s.isolated).toBeNull();
    expect(hidden(s).ids.has(6)).toBe(false);
    expect(hidden(s).ids.has(1)).toBe(true);
    s = visReduce(s, { t: "storey", keep: null });
    expect(ids(hidden(s))).toEqual([]);
  });

  it("show all returns to the initial state, x-ray included", () => {
    let s = visReduce(INITIAL_VIS, { t: "model", modelId: "a", visible: false });
    s = visReduce(s, { t: "xray", solid: idsOf("a", [1]) });
    s = visReduce(s, { t: "isolate", ids: idsOf("a", [1]) });
    expect(visReduce(s, { t: "showAll" })).toBe(INITIAL_VIS);
  });
});

describe("x-ray", () => {
  it("lists the opaque elements per model", () => {
    const s = visReduce(INITIAL_VIS, { t: "xray", solid: idsOf("a", [4]) });
    expect(ghostSolid(s, "a")).toEqual(new Set([4]));
    expect(ghostSolid(s, "b")).toEqual(new Set()); // a model with nothing solid is entirely ghosted
    expect(ghostSolid(INITIAL_VIS, "a")).toBeNull();
    expect(isFiltered(s)).toBe(true);
  });
});

describe("planApply", () => {
  const H = (all: boolean, list: number[] = []): Hidden => ({ all, ids: new Set(list) });
  it("applies only the delta", () => {
    expect(planApply(H(false, [1, 2]), H(false, [2, 3]))).toEqual([{ op: "show", ids: [1] }, { op: "hide", ids: [3] }]);
    expect(planApply(H(false, [1]), H(false, [1]))).toEqual([]);
    expect(planApply(undefined, H(false, [5]))).toEqual([{ op: "hide", ids: [5] }]);
  });
  it("hides and restores a whole model in one call", () => {
    expect(planApply(H(false, [1]), H(true))).toEqual([{ op: "hideAll" }]);
    expect(planApply(H(true), H(true))).toEqual([]);
    expect(planApply(H(true), H(false))).toEqual([{ op: "showAll" }]);
    expect(planApply(H(true), H(false, [2]))).toEqual([{ op: "showAll" }, { op: "hide", ids: [2] }]);
  });
});

describe("groupVisibility", () => {
  it("is tri-state", () => {
    expect(groupVisibility({ all: false, ids: new Set() }, [1, 2])).toBe("all");
    expect(groupVisibility({ all: false, ids: new Set([1]) }, [1, 2])).toBe("some");
    expect(groupVisibility({ all: false, ids: new Set([1, 2]) }, [1, 2])).toBe("none");
    expect(groupVisibility({ all: true, ids: new Set() }, [1, 2])).toBe("none");
  });
});

describe("clearing one layer", () => {
  it("clears isolate, hidden ids, categories and models separately", () => {
    let s = visReduce(INITIAL_VIS, { t: "isolate", ids: idsOf("a", [1]) });
    s = visReduce(s, { t: "category", name: "IFCWALL", visible: false });
    s = visReduce(s, { t: "model", modelId: "b", visible: false });
    s = visReduce(s, { t: "hide", ids: idsOf("a", [1]) });
    expect(visReduce(s, { t: "clearIsolate" }).isolated).toBeNull();
    expect(visReduce(s, { t: "clearHidden" }).hiddenIds.size).toBe(0);
    expect(visReduce(s, { t: "clearCategories" }).hiddenCategories.size).toBe(0);
    expect(visReduce(s, { t: "clearModels" }).hiddenModels.size).toBe(0);
    expect(visReduce(s, { t: "clearCategories" }).hiddenModels.size).toBe(1); // the others stay
  });
  it("hides every listed category at once", () => {
    const s = visReduce(INITIAL_VIS, { t: "allCategories", names: ["IFCWALL", "IFCDOOR"] });
    expect(ids(hidden(s))).toEqual([1, 2, 3, 4, 5]);
  });
});
