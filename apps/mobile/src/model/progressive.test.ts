import { describe, expect, it } from "vitest";
import type { IfcFileListItem } from "@ff/viewer-react";
import { planBatches, releasedAfter } from "./progressive";

const MB = 1024 * 1024;
const f = (id: string): IfcFileListItem => ({ file: { id, name: id, buildingId: "b" }, latestVersion: { id: `v-${id}`, fragBlobKey: id, versionNumber: 1 } });
const sizes = new Map([["arch", 89 * MB], ["mech", 29 * MB], ["str", 0.5 * MB], ["arch2", 89 * MB], ["mech2", 29 * MB]]);
const ids = (b: IfcFileListItem[][]) => b.map((x) => x.map((y) => y.file.id));

describe("planBatches", () => {
  it("puts the smallest models first and cuts by bytes", () => {
    expect(ids(planBatches([f("arch"), f("mech"), f("str")], sizes))).toEqual([["str"], ["mech", "arch"]]);
  });
  it("keeps parallelism in later batches", () => {
    expect(ids(planBatches([f("arch"), f("arch2"), f("mech"), f("mech2"), f("str")], sizes))).toEqual([["str"], ["mech", "mech2", "arch"], ["arch2"]]);
  });
  it("a model bigger than the cap is a batch of its own, never dropped", () => {
    expect(ids(planBatches([f("arch")], sizes, 1 * MB, 1 * MB))).toEqual([["arch"]]);
  });
  it("unknown sizes keep their order and lead", () => {
    expect(ids(planBatches([f("a"), f("b"), f("arch")], sizes)).flat()).toEqual(["a", "b", "arch"]);
  });
  it("is empty for no files", () => {
    expect(planBatches([], sizes)).toEqual([]);
  });
});

describe("releasedAfter", () => {
  it("waits until every released model is loaded", () => {
    expect(releasedAfter(1, [2, 1], 1)).toBe(1);
    expect(releasedAfter(1, [2, 1], 2)).toBe(2);
  });
  it("stops at the last batch", () => {
    expect(releasedAfter(2, [2, 1], 3)).toBe(2);
  });
});
