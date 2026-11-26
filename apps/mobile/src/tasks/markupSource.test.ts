import { describe, expect, it } from "vitest";
import { availableSources, planMarkup } from "./markupSource";

const pdf = { pdfFileId: "p1", page: 1, uv: [0.2, 0.4] as [number, number] };
const bimPoint = { elements: [], worldPoint: [1, 2, 3] as [number, number, number], cameraPose: null };
const bimEl = { elements: [{ modelId: "m", expressId: 4 }], worldPoint: null, cameraPose: null };

describe("availableSources", () => {
  it("reads the plan pin and the 3D anchor", () => {
    expect(availableSources({ pdf })).toEqual(["plan"]);
    expect(availableSources({ bim: bimPoint })).toEqual(["3d"]);
    expect(availableSources({ bim: bimEl })).toEqual(["3d"]);
    expect(availableSources({ pdf, bim: bimPoint })).toEqual(["plan", "3d"]);
  });
  it("is empty without a usable location", () => {
    expect(availableSources(null)).toEqual([]);
    expect(availableSources({})).toEqual([]);
    expect(availableSources({ pdf: null, bim: null })).toEqual([]);
    expect(availableSources({ pdf: { pdfFileId: "", uv: [0.1, 0.1] } })).toEqual([]);
    expect(availableSources({ pdf: { pdfFileId: "p1", uv: [2, 0.1] } })).toEqual([]);
    expect(availableSources({ bim: { elements: [], worldPoint: null, cameraPose: null } })).toEqual([]);
  });
});

describe("planMarkup", () => {
  it("captures straight away when there is one kind of location", () => {
    expect(planMarkup({ pdf }, null)).toEqual({ kind: "direct", source: "plan" });
    expect(planMarkup({ bim: bimPoint }, "plan")).toEqual({ kind: "direct", source: "3d" });
  });
  it("asks first when there are both", () => {
    expect(planMarkup({ pdf, bim: bimPoint }, null)).toEqual({ kind: "choose", sources: ["plan", "3d"] });
    expect(planMarkup({ pdf, bim: bimPoint }, "bogus")).toEqual({ kind: "choose", sources: ["plan", "3d"] });
  });
  it("honours the choice that was made", () => {
    expect(planMarkup({ pdf, bim: bimPoint }, "3d")).toEqual({ kind: "direct", source: "3d" });
    expect(planMarkup({ pdf, bim: bimPoint }, "plan")).toEqual({ kind: "direct", source: "plan" });
  });
  it("explains when there is no location", () => {
    expect(planMarkup({}, "plan")).toEqual({ kind: "none" });
  });
});
