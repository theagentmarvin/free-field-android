import { describe, expect, it } from "vitest";
import { looksLikeGuid, matchCategories, mergeCategoryCounts, mergeHits, parseQuery, textRegex } from "./search";

describe("parseQuery", () => {
  it("recognises a GlobalId", () => {
    const q = parseQuery("  1h8bhnJt58ovHTHWAGg2LF ");
    expect(q).toMatchObject({ kind: "guid", guid: "1h8bhnJt58ovHTHWAGg2LF" });
  });
  it("does not take a long word for a GlobalId", () => {
    expect(looksLikeGuid("ARCHITECTURALMODELLING")).toBe(false);
    expect(looksLikeGuid("1h8bhnJt58ovHTHWAGg2L")).toBe(false); // 21
    expect(parseQuery("ARCHITECTURALMODELLING").kind).toBe("text");
  });
  it("reads #123 and bare numbers as local ids", () => {
    expect(parseQuery("#1057")).toMatchObject({ kind: "id", localId: 1057 });
    expect(parseQuery("1057")).toMatchObject({ kind: "id", localId: 1057 });
  });
  it("treats empty and one-letter input as empty", () => {
    expect(parseQuery("   ").kind).toBe("empty");
    expect(parseQuery("a").kind).toBe("empty");
    expect(parseQuery("ab").kind).toBe("text");
  });
});

describe("textRegex", () => {
  it("is case-insensitive, escapes specials and spans whitespace", () => {
    expect(textRegex("Beam:12").test('Concrete-Rectangular beam:12" x 18"')).toBe(true);
    expect(textRegex("a.b").test("axb")).toBe(false);
    expect(textRegex("rect  beam").test("Rect\tbeam")).toBe(true);
    expect(textRegex("(x)").test("a (x) b")).toBe(true);
  });
});

describe("matchCategories", () => {
  const cats = [
    { name: "IFCWALL", count: 40 },
    { name: "IFCWALLSTANDARDCASE", count: 900 },
    { name: "IFCDUCTSEGMENT", count: 300 },
    { name: "IFCDUCTFITTING", count: 120 },
    { name: "IFCSLAB", count: 12 },
    { name: "IFCFLOWTERMINAL", count: 55 },
  ];
  it("finds the classes of a type word, best label match first", () => {
    expect(matchCategories("wall", cats).map((c) => c.name)).toEqual(["IFCWALLSTANDARDCASE", "IFCWALL"]);
    expect(matchCategories("duct", cats).map((c) => c.name)).toEqual(["IFCDUCTSEGMENT", "IFCDUCTFITTING"]);
  });
  it("matches a word inside a label and the raw IFC name", () => {
    expect(matchCategories("fittings", cats).map((c) => c.name)).toEqual(["IFCDUCTFITTING"]); // a word inside the label "Duct fittings"
  });
  it("matches the raw class name", () => {
    expect(matchCategories("ifcslab", cats).map((c) => c.name)).toEqual(["IFCSLAB"]);
    expect(matchCategories("terminal", cats).map((c) => c.name)).toEqual(["IFCFLOWTERMINAL"]);
  });
  it("ignores one-letter queries and caps the list", () => {
    expect(matchCategories("w", cats)).toEqual([]);
    expect(matchCategories("ifc", cats, 2)).toHaveLength(2);
  });
});

describe("mergeCategoryCounts", () => {
  it("sums a class across models", () => {
    expect(mergeCategoryCounts([[{ name: "A", count: 1 }, { name: "B", count: 2 }], [{ name: "A", count: 4 }]])).toEqual([{ name: "A", count: 5 }, { name: "B", count: 2 }]);
  });
});

describe("mergeHits", () => {
  const h = (modelId: string, localId: number, kind: "id" | "guid" | "name" | "property") => ({ modelId, localId, kind });
  it("orders guid, id, name, property and keeps the best kind per element", () => {
    const m = mergeHits([h("a", 3, "property"), h("a", 1, "name"), h("a", 3, "name"), h("b", 9, "guid"), h("a", 1, "property")], 10);
    expect(m.hits.map((x) => `${x.modelId}${x.localId}:${x.kind}`)).toEqual(["b9:guid", "a1:name", "a3:name"]);
    expect(m.total).toBe(3);
    expect(m.truncated).toBe(false);
  });
  it("caps the rows and reports the full count", () => {
    const parts = Array.from({ length: 120 }, (_, i) => h("a", i, "name"));
    const m = mergeHits(parts, 50);
    expect(m.hits).toHaveLength(50);
    expect(m.total).toBe(120);
    expect(m.truncated).toBe(true);
  });
});
