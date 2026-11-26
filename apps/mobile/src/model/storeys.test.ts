import { describe, expect, it } from "vitest";
import type { StoreyRecord } from "@ff/types";
import { isolationPlan, storeyChips } from "./storeys";
import { resolveSource, toFileItems } from "./sourceLogic";
import { vi } from "vitest";
vi.mock("@ff/viewer-react", () => ({
  // same contract as the real helper: pset grouping hangs off a non-enumerable symbol
  getPropertyGroups: (r: Record<string, string>) => (r as unknown as Record<symbol, unknown>)[Symbol.for("ff.viewer.propertyGroups")] ?? null,
}));
import { toElementProps } from "./properties";

const row = (name: string, elevation: number, file: string, ids: number[]) =>
  ({ id: `${name}-${file}`, buildingId: "b", ifcVersionId: "v", sourceIfcFileId: file, name, elevation, expressId: 1, height: null, containedElementIds: ids }) as StoreyRecord;

describe("storeyChips", () => {
  it("merges same-named storeys across model files, lowest first", () => {
    const chips = storeyChips([row("L2", 3, "f1", [1, 2]), row("L1", 0, "f1", [3]), row("L2", 3.01, "f2", [9])]);
    expect(chips.map((c) => c.name)).toEqual(["L1", "L2"]);
    expect(chips[1].byModel.get("f2")).toEqual(new Set([9]));
    expect(chips[1].elevation).toBe(3);
  });
});

describe("isolationPlan", () => {
  const chip = storeyChips([row("L2", 3, "f1", [1, 2]), row("L2", 3, "f2", [])])[0];
  const all = new Map([
    ["f1", [1, 2, 3, 4]],
    ["f2", [10, 11]],
  ]);

  it("shows the synced contained ids and hides everything else", () => {
    const plan = isolationPlan(chip, all, new Map());
    expect(plan.find((p) => p.modelId === "f1")).toMatchObject({ show: new Set([1, 2]), hide: new Set([3, 4]) });
    // a model with no elements in the storey is hidden whole
    expect(plan.find((p) => p.modelId === "f2")).toMatchObject({ show: new Set(), hide: new Set([10, 11]) });
  });

  it("prefers the model's own spatial tree when it knows the storey", () => {
    const levels = new Map([["f1", new Map([["L2", new Set([2, 3, 4])]])]]);
    const p = isolationPlan(chip, all, levels).find((x) => x.modelId === "f1")!;
    expect(p.show).toEqual(new Set([2, 3, 4]));
    expect(p.hide).toEqual(new Set([1]));
  });
});

describe("resolveSource", () => {
  it("downloaded wins, the sample only in demo mode, otherwise none", () => {
    expect(resolveSource(undefined, true)).toBe("loading");
    expect(resolveSource([{ localKey: "k" } as never], false)).toBe("downloaded");
    expect(resolveSource([{ localKey: "k" } as never], true)).toBe("downloaded");
    expect(resolveSource([], true)).toBe("sample");
    expect(resolveSource([], false)).toBe("none");
  });
  it("maps downloaded rows to viewer list items with the frag blob key", () => {
    const items = toFileItems([
      { file: { id: "f", name: "S.ifc", buildingId: "b" }, version: { id: "v", fragBlobKey: "f__v2", versionNumber: 2 }, localKey: "frag/f__v2.frag", localPath: "blobs/frag/f__v2.frag" } as never,
    ]);
    expect(items).toEqual([{ file: { id: "f", name: "S.ifc", buildingId: "b" }, latestVersion: { id: "v", fragBlobKey: "f__v2", versionNumber: 2 } }]);
  });
});

describe("toElementProps", () => {
  it("separates attributes from property sets and hides engine-internal keys", () => {
    const data: Record<string, string> = { Name: "Wall A", GlobalId: "2xYz", Tag: "", _category: "IFCWALL", "Pset_WallCommon.FireRating": "2h", "Pset_WallCommon.IsExternal": "true" };
    const p = toElementProps(data, "Element 5");
    expect(p.title).toBe("Wall A");
    expect(p.category).toBe("IFCWALL");
    expect(p.guid).toBe("2xYz");
    expect(p.attributes).toEqual([
      ["Name", "Wall A"],
      ["GlobalId", "2xYz"],
    ]);
    expect(p.psets).toEqual([{ name: "Pset_WallCommon", rows: [["FireRating", "2h"], ["IsExternal", "true"]] }]);
  });
  it("uses the viewer's pset grouping when present (dots in names stay intact)", () => {
    const data: Record<string, string> = { Name: "Slab", "Pset 1.2.Load": "5" };
    Object.defineProperty(data, Symbol.for("ff.viewer.propertyGroups"), { value: [{ pset: "Pset 1.2", properties: [["Load", "5"]] }] });
    const p = toElementProps(data, "x");
    expect(p.psets).toEqual([{ name: "Pset 1.2", rows: [["Load", "5"]] }]);
    expect(p.attributes).toEqual([["Name", "Slab"]]);
  });
  it("falls back to a generic title", () => {
    expect(toElementProps({}, "Element 9").title).toBe("Element 9");
  });
});
