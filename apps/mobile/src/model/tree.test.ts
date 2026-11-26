import { describe, expect, it } from "vitest";
import { buildModelTree, categoryLabel, collectIds, normalizeSpatial, flattenRows, isSpatialCategory, PAGE, rowNameIds, type SpatialItem, type TNode } from "./tree";

const el = (id: number, category: string): SpatialItem => ({ category, localId: id });
const sample = (): SpatialItem => ({
  category: "IFCPROJECT",
  localId: 1,
  children: [
    {
      category: "IFCSITE",
      localId: 2,
      children: [
        {
          category: "IFCBUILDING",
          localId: 3,
          children: [
            { category: "IFCBUILDINGSTOREY", localId: 10, children: [el(100, "IFCWALL"), el(101, "IFCWALL"), el(102, "IFCDOOR"), { category: "IFCSPACE", localId: 50, children: [el(103, "IFCFURNISHINGELEMENT")] }] },
            { category: "IFCBUILDINGSTOREY", localId: 11, children: [el(200, "IFCSLAB")] },
          ],
        },
      ],
    },
  ],
});

describe("labels", () => {
  it("names common classes and title-cases the rest", () => {
    expect(categoryLabel("IFCWALLSTANDARDCASE")).toBe("Walls");
    expect(categoryLabel("IFCDUCTSEGMENT")).toBe("Duct segments");
    expect(categoryLabel("IFCSOMETHINGNEW")).toBe("Somethingnew");
    expect(categoryLabel(null)).toBe("Other");
  });
  it("knows the spatial containers", () => {
    expect(isSpatialCategory("IFCBUILDINGSTOREY")).toBe(true);
    expect(isSpatialCategory("IFCWALL")).toBe(false);
    expect(isSpatialCategory(null)).toBe(false);
  });
});

describe("collectIds", () => {
  it("lists every id below an item, depth first", () => {
    expect(collectIds(sample()).sort((a, b) => a - b)).toEqual([1, 2, 3, 10, 11, 50, 100, 101, 102, 103, 200]);
  });
  it("survives a deep chain (no recursion)", () => {
    let item: SpatialItem = el(0, "IFCWALL");
    for (let i = 1; i < 20000; i++) item = { category: "IFCBUILDINGELEMENTPROXY", localId: i, children: [item] };
    expect(collectIds(item)).toHaveLength(20000);
  });
});

describe("buildModelTree", () => {
  const tree = buildModelTree("a", "ARCHITECTURAL", sample());
  it("folds the project and site away: the model's children are the building", () => {
    expect(tree.kind).toBe("model");
    expect(tree.fallback).toBe("ARCHITECTURAL");
    const kids = tree.children!();
    expect(kids.map((k) => k.fallback)).toEqual(["Building 3"]);
    expect(kids[0].kind).toBe("spatial");
  });
  it("lists storeys, then groups the storey's elements by class, then the elements", () => {
    const building = tree.children!()[0];
    const storeys = building.children!();
    expect(storeys.map((s) => s.localId)).toEqual([10, 11]);
    const first = storeys[0].children!();
    expect(first.map((n) => [n.kind, n.fallback, n.count])).toEqual([
      ["spatial", "Space 50", 1],
      ["group", "Walls", 2],
      ["group", "Doors", 1],
    ]);
    const walls = first.find((n) => n.fallback === "Walls")!;
    expect(walls.children!().map((e) => e.localId)).toEqual([100, 101]);
    expect(walls.ids()).toEqual([100, 101]);
  });
  it("counts elements, not containers", () => {
    expect(tree.count).toBe(5);
    expect(tree.ids()).toHaveLength(11);
  });
  it("a spatial node's ids include everything below it", () => {
    const storey = tree.children!()[0].children!()[0];
    expect(storey.ids().sort((a, b) => a - b)).toEqual([10, 50, 100, 101, 102, 103]);
  });
  it("does not create children until asked", () => {
    let calls = 0;
    const lazy: SpatialItem = { category: "IFCBUILDING", localId: 3, get children() { calls++; return [{ category: "IFCBUILDINGSTOREY", localId: 4, children: [] }]; } };
    const t = buildModelTree("m", "M", lazy);
    t.children!();
    expect(calls).toBeGreaterThan(0);
  });
  it("a model without containers lists its elements in class groups", () => {
    const flat: SpatialItem = { category: null, localId: null, children: [el(1, "IFCWALL"), el(2, "IFCWALL"), el(3, "IFCSLAB")] };
    const t = buildModelTree("a", "A", flat);
    expect(t.children!().map((g) => [g.kind, g.fallback, g.count])).toEqual([["group", "Walls", 2], ["group", "Slabs", 1]]);
  });
});

describe("flattenRows", () => {
  const tree = buildModelTree("a", "A", sample());
  it("shows only collapsed roots until something is expanded", () => {
    const rows = flattenRows([tree], new Set());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: "node", depth: 0, expanded: false });
  });
  it("expands one level at a time", () => {
    const rows = flattenRows([tree], new Set([tree.key]));
    expect(rows.map((r) => (r.type === "node" ? r.node.fallback : "more"))).toEqual(["A", "Building 3"]);
    const b = tree.children!()[0];
    const rows2 = flattenRows([tree], new Set([tree.key, b.key]));
    expect(rows2.filter((r) => r.type === "node").map((r) => (r as { depth: number }).depth)).toEqual([0, 1, 2, 2]);
  });
  it("pages a big group and offers more", () => {
    const big: SpatialItem = { category: "IFCBUILDINGSTOREY", localId: 10, children: Array.from({ length: 250 }, (_, i) => el(1000 + i, "IFCWALL")) };
    const t = buildModelTree("a", "A", { category: null, localId: null, children: [{ category: "IFCBUILDING", localId: 3, children: [big] }] });
    const storey = t.children!()[0].children!()[0];
    const group = storey.children!()[0];
    const open = new Set([t.key, t.children!()[0].key, storey.key, group.key]);
    const rows = flattenRows([t], open);
    const more = rows[rows.length - 1];
    expect(more).toMatchObject({ type: "more", remaining: 250 - PAGE, parentKey: group.key });
    expect(rows.filter((r) => r.type === "node" && (r as { node: TNode }).node.kind === "element")).toHaveLength(PAGE);
    const all = flattenRows([t], open, new Map([[group.key, 250]]));
    expect(all.filter((r) => r.type === "node" && (r as { node: TNode }).node.kind === "element")).toHaveLength(250);
    expect(all[all.length - 1].type).toBe("node");
  });
  it("collects the ids whose names the rows need", () => {
    const b = tree.children!()[0];
    const rows = flattenRows([tree], new Set([tree.key, b.key]));
    expect(rowNameIds(rows).get("a")).toEqual([3, 10, 11]);
  });
});

describe("normalizeSpatial", () => {
  // the engine's real shape: class nodes (no id) above id nodes (no class)
  const raw = {
    category: "IFCPROJECT",
    localId: null,
    children: [
      {
        category: null,
        localId: 27,
        children: [
          {
            category: "IFCSITE",
            localId: null,
            children: [
              {
                category: null,
                localId: 58,
                children: [
                  {
                    category: "IFCBUILDING",
                    localId: null,
                    children: [
                      {
                        category: null,
                        localId: 32,
                        children: [
                          {
                            category: "IFCBUILDINGSTOREY",
                            localId: null,
                            children: [
                              { category: null, localId: 36, children: [] },
                              { category: null, localId: 40, children: [{ category: "IFCSLAB", localId: null, children: [{ category: null, localId: 79, children: [] }, { category: null, localId: 125, children: [] }] }, { category: "IFCCOLUMN", localId: null, children: [{ category: null, localId: 6509, children: [] }] }] },
                            ],
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  it("gives every element its class and nests contents below it", () => {
    const n = normalizeSpatial(raw);
    expect(collectIds(n).sort((a, b) => a - b)).toEqual([27, 32, 36, 40, 58, 79, 125, 6509]);
    const tree = buildModelTree("m", "M", n);
    const building = tree.children!()[0];
    expect(building.category).toBe("IFCBUILDING");
    const storeys = building.children!();
    expect(storeys.map((s) => [s.category, s.localId])).toEqual([["IFCBUILDINGSTOREY", 36], ["IFCBUILDINGSTOREY", 40]]);
    const groups = storeys[1].children!();
    expect(groups.map((g) => [g.fallback, g.count])).toEqual([["Slabs", 2], ["Columns", 1]]);
    expect(groups[0].children!().map((e) => e.localId)).toEqual([79, 125]);
    expect(tree.count).toBe(3);
  });
});
