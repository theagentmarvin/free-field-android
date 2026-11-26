import { describe, expect, it } from "vitest";
import { anchorToLocation, buildNewTaskPath, formatAnchor, locationToAnchor, modelLink, parseAnchor, parseNewTaskParams, planLink, type TaskAnchor } from "./anchor";

const pdf: TaskAnchor = { kind: "pdf", pdfFileId: "f-1", page: 2, uv: [0.25, 0.75], calibId: "c_9" };
const bim: TaskAnchor = {
  kind: "bim", elements: [{ modelId: "m-1", expressId: 42 }, { modelId: "m-1", expressId: 7 }],
  worldPoint: [1, -2.5, 3], cameraPose: { pos: [1, 2, 3], target: [0, 0, 0], fov: 60, isOrtho: false },
};
describe("anchor format", () => {
  it("round-trips pdf and bim", () => {
    expect(formatAnchor(pdf)).toBe("pdf:f-1/2/0.25,0.75/c_9");
    expect(parseAnchor(formatAnchor(pdf))).toEqual(pdf);
    expect(parseAnchor(formatAnchor(bim))).toEqual(bim);
    expect(parseAnchor("bim:@1,2,3")).toEqual({ kind: "bim", elements: [], worldPoint: [1, 2, 3], cameraPose: null });
  });
  it("accepts the plan viewer's plan~ anchors", () => {
    expect(parseAnchor("plan~f-1~v-2~3~0.5~0.25")).toEqual({
      kind: "pdf", pdfFileId: "f-1", page: 3, uv: [0.5, 0.25], calibId: "uncalibrated", planVersionId: "v-2",
    });
    for (const bad of ["plan~f~v~0~0.5~0.5", "plan~f~v~1~2~0.5", "plan~f~v~1~0.5", "plan~f g~v~1~0.5~0.5"]) expect(parseAnchor(bad), bad).toBeNull();
    expect(parseNewTaskParams(`anchor=${encodeURIComponent("plan~f~v~1~0.1~0.2")}`).anchor?.kind).toBe("pdf");
  });
  it("stamps the plan revision (pdfVersionId) on a pin placed in the plan viewer", () => {
    const a = parseAnchor("plan~f-1~v-2~3~0.5~0.25")!;
    const loc = anchorToLocation(a, "L1");
    expect(loc?.pdf).toMatchObject({ pdfFileId: "f-1", page: 3, calibId: "uncalibrated", pdfVersionId: "v-2" });
    expect(locationToAnchor(loc)).toEqual(a);
    expect(anchorToLocation(pdf, null)?.pdf).not.toHaveProperty("pdfVersionId"); // legacy pdf: anchors carry none
  });
  it("rejects malformed anchors", () => {
    for (const bad of ["", "pdf:f/0/1,1/c", "pdf:f/1/1/c", "pdf:f/1/a,b/c", "bim:", "bim:m.x", "bim:@1,2", "foo:bar", "pdf:f g/1/1,1/c", "bim:m.1~1,2,3,4,5,6,7,2"])
      expect(parseAnchor(bad), bad).toBeNull();
    expect(parseAnchor(null)).toBeNull();
  });
  it("builds and parses /tasks/new paths", () => {
    const path = buildNewTaskPath({ anchor: pdf, buildingId: "b1", storey: "Level 2" });
    expect(path.startsWith("/tasks/new?")).toBe(true);
    const p = parseNewTaskParams(path.split("?")[1]);
    expect(p).toEqual({ anchor: pdf, buildingId: "b1", storey: "Level 2", draftId: null });
    expect(buildNewTaskPath()).toBe("/tasks/new");
    expect(parseNewTaskParams("draft=d1").draftId).toBe("d1");
  });
  it("converts to and from task locations", () => {
    expect(locationToAnchor(anchorToLocation(pdf, "L2"))).toEqual(pdf);
    expect(locationToAnchor(anchorToLocation(bim, null))).toEqual(bim);
    expect(anchorToLocation(null, "L1")).toEqual({ storeyName: "L1", bim: null, pdf: null });
    expect(anchorToLocation(null, null)).toBeNull();
  });
  it("deep links never throw", () => {
    expect(planLink(anchorToLocation(pdf, null), "t1")).toBe("/plans/f-1?task=t1&page=2");
    expect(planLink(null, "t1")).toBeNull();
    expect(modelLink({ bim: {} }, "b1", "t1")).toBe("/model/b1?task=t1");
    expect(modelLink({ bim: {} }, null, "t1")).toBe("/model?task=t1");
    expect(modelLink({ bim: null }, "b1", "t1")).toBeNull();
  });
});
