import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { ProjectDatabase } from "@ff/data/db/database";
import { captureView, cleanName, decodeView, defaultName, deleteView, encodeView, MAX_VIEWS_PER_BUILDING, planeToAxis, renameView, restorePlan, saveView, viewsForBuilding, webVisibility } from "./viewpoints";
import { INITIAL_VIS, idsOf, type VisState } from "./visibility";
import { sectionPlanes, type SectionState } from "./sectionBox";

let n = 0;
const mkdb = () => new ProjectDatabase(`views-test-${Date.now()}-${n++}`);
const BOUNDS = { min: [0, 0, 0] as [number, number, number], max: [20, 10, 20] as [number, number, number] };
const pose = { pos: [10, 5, 10] as [number, number, number], target: [0, 0, 0] as [number, number, number], fov: 45, isOrtho: false };
const state = (over: Partial<Parameters<typeof captureView>[0]> = {}) => ({ pose, section: { box: null, planes: [] } as SectionState, secBounds: BOUNDS, vis: INITIAL_VIS, level: null, cut: false, buildingId: "b1", ...over });

describe("capture and restore", () => {
  it("round-trips camera, section, level, cut, hidden models, categories, ids, isolate and x-ray", () => {
    const vis: VisState = {
      ...INITIAL_VIS,
      hiddenModels: new Set(["m2"]),
      hiddenCategories: new Set(["IFCDOOR"]),
      hiddenIds: idsOf("m1", [4, 5]),
      forced: idsOf("m1", [6]),
      isolated: idsOf("m1", [1, 2]),
      solid: idsOf("m1", [1]),
    };
    const section: SectionState = { box: { min: [1, 1, 1], max: [5, 5, 5] }, planes: [{ axis: "y", offset: 3, flipped: true }] };
    const blob = decodeView(encodeView(captureView(state({ vis, section, level: "L2", cut: true }))))!;
    const plan = restorePlan(blob);
    expect(plan.pose).toEqual(pose);
    expect(plan.section).toEqual(section);
    expect(plan.level).toBe("L2");
    expect(plan.cut).toBe(true);
    expect(plan.hiddenModels).toEqual(["m2"]);
    expect(plan.hiddenCategories).toEqual(["IFCDOOR"]);
    expect([...plan.hiddenIds.get("m1")!]).toEqual([4, 5]);
    expect([...plan.forced.get("m1")!]).toEqual([6]);
    expect([...plan.isolated!.get("m1")!]).toEqual([1, 2]);
    expect([...plan.solid!.get("m1")!]).toEqual([1]);
  });

  it("keeps the web fields: engine planes of the section and hidden / isolated ids", () => {
    const section: SectionState = { box: { min: [1, 1, 1], max: [5, 5, 5] }, planes: [] };
    const b = captureView(state({ section, vis: { ...INITIAL_VIS, hiddenIds: idsOf("m1", [9]) } }));
    expect(b.sectionPlanes).toHaveLength(6);
    expect(b.sectionPlanes).toEqual(sectionPlanes(section, BOUNDS));
    expect(b.visibility).toEqual({ hidden: [{ modelId: "m1", ids: [9] }], isolate: null });
    expect(webVisibility(INITIAL_VIS)).toBeNull();
  });

  it("a cut without a level is not saved as a cut", () => {
    expect(captureView(state({ cut: true, level: null })).mobile!.cut).toBe(false);
  });

  it("a web view (no mobile block) restores its camera, axis planes and hidden ids; slanted planes are counted", () => {
    const web = {
      pose,
      sectionPlanes: [
        { point: { x: 0, y: 4, z: 0 }, normal: { x: 0, y: -1, z: 0 } },
        { point: { x: 2, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 } },
        { point: { x: 0, y: 0, z: 0 }, normal: { x: 0.7071, y: 0, z: 0.7071 } },
      ],
      visibility: { hidden: [{ modelId: "m1", ids: [3] }], isolate: { visible: [{ modelId: "m1", ids: [7] }] } },
    };
    const plan = restorePlan(decodeView(JSON.stringify(web))!);
    expect(plan.section.planes).toEqual([
      { axis: "y", offset: 4, flipped: false },
      { axis: "x", offset: 2, flipped: true },
    ]);
    expect(plan.droppedPlanes).toBe(1);
    expect([...plan.hiddenIds.get("m1")!]).toEqual([3]);
    expect([...plan.isolated!.get("m1")!]).toEqual([7]);
  });

  it("planeToAxis refuses slanted planes", () => {
    expect(planeToAxis({ point: { x: 0, y: 0, z: 0 }, normal: { x: 1, y: 1, z: 0 } })).toBeNull();
  });

  it("decode rejects garbage and legacy blobs lack visibility", () => {
    expect(decodeView("nope")).toBeNull();
    expect(decodeView("{}")).toBeNull();
    const legacy = decodeView(JSON.stringify({ pose: null, sectionPlanes: [] }))!;
    expect("visibility" in legacy).toBe(false);
    expect(legacy.pose).toBeNull();
  });
});

describe("names", () => {
  it("cleans and defaults", () => {
    expect(cleanName("  a   b  ")).toBe("a b");
    expect(cleanName("x".repeat(100))).toHaveLength(60);
    expect(defaultName([])).toBe("View 1");
    expect(defaultName([{ name: "View 1" }, { name: "Plant room" }, { name: "View 4" }])).toBe("View 5");
  });
});

describe("rows", () => {
  it("saves, lists per building (web views everywhere), renames and deletes", async () => {
    const db = mkdb();
    await saveView(db, "p", "b1", "  North  ", captureView(state()), 1, "v1");
    await saveView(db, "p", "b2", "Other building", captureView(state({ buildingId: "b2" })), 2, "v2");
    await db.viewerViewpoints.put({ id: "w1", projectId: "p", name: "From web", createdAt: 0, blob: JSON.stringify({ pose, sectionPlanes: [] }) });
    await db.viewerViewpoints.put({ id: "x", projectId: "other-project", name: "No", createdAt: 3, blob: encodeView(captureView(state())) });
    const rows = await db.viewerViewpoints.where("projectId").equals("p").toArray();
    const b1 = viewsForBuilding(rows, "b1");
    expect(b1.map((v) => v.name)).toEqual(["From web", "North"]);
    expect(b1[0].fromWeb).toBe(true);
    expect(viewsForBuilding(rows, "b2").map((v) => v.id)).toEqual(["w1", "v2"]);
    expect(await renameView(db, "v1", "  South wing ")).toBe(true);
    expect(await renameView(db, "v1", "   ")).toBe(false);
    expect((await db.viewerViewpoints.get("v1"))!.name).toBe("South wing");
    await deleteView(db, "v1");
    expect(await db.viewerViewpoints.get("v1")).toBeUndefined();
    await expect(saveView(db, "p", "b1", " ", captureView(state()))).rejects.toThrow();
  });

  it("caps a building at 12 views by dropping its oldest, and never touches another building's", async () => {
    const db = mkdb();
    await saveView(db, "p", "b2", "keep", captureView(state({ buildingId: "b2" })), 0, "keep");
    for (let i = 1; i <= MAX_VIEWS_PER_BUILDING + 2; i++) await saveView(db, "p", "b1", `V${i}`, captureView(state()), i, `id${i}`);
    const rows = await db.viewerViewpoints.where("projectId").equals("p").toArray();
    const b1 = viewsForBuilding(rows, "b1");
    expect(b1).toHaveLength(MAX_VIEWS_PER_BUILDING);
    expect(b1[0].name).toBe("V3");
    expect(b1[b1.length - 1].name).toBe(`V${MAX_VIEWS_PER_BUILDING + 2}`);
    expect(viewsForBuilding(rows, "b2").map((v) => v.id)).toEqual(["keep"]);
  });
});
