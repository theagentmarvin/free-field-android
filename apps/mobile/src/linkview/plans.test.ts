import { describe, expect, it } from "vitest";
import type { CalibrationRecord } from "@ff/types";
import { calibratedPlans, choosePlan, levelOf, modelPinsFromPlan, planPinsFromModel, plansForStorey, sortPlans, storeyBand } from "./plans";
import type { PlanPin } from "../plans/pins";
import { worldFromPage } from "./sync";

const params = { scale: 0.05, rotation: 0, translateX: 0, translateZ: 0 };
const cal = (o: Partial<CalibrationRecord> & Pick<CalibrationRecord, "id" | "pdfFileId" | "storeyName">): CalibrationRecord => ({ projectId: "p1", pointPairs: [{ pdfX: 0, pdfY: 0, worldX: 0, worldZ: 0 }, { pdfX: 100, pdfY: 0, worldX: 5, worldZ: 0 }], transformParams: params, confidence: 1, createdAt: 1, updatedAt: 1, ...o });
const files = [
  { id: "f1", name: "S-101", buildingId: "b1" },
  { id: "f2", name: "S-201", buildingId: "b1" },
  { id: "f3", name: "Other", buildingId: "b2" },
];
const storeys = [{ name: "L1" }, { name: "L2" }];

describe("calibratedPlans", () => {
  it("keeps the newest calibration per (plan, storey) of this building and project, with a real storey and scale", () => {
    const out = calibratedPlans({
      files,
      storeys,
      projectId: "p1",
      buildingId: "b1",
      calibrations: [
        cal({ id: "a", pdfFileId: "f1", storeyName: "L1", updatedAt: 1 }),
        cal({ id: "b", pdfFileId: "f1", storeyName: "L1", updatedAt: 5 }),
        cal({ id: "c", pdfFileId: "f1", storeyName: "L2", updatedAt: 2 }), // one PDF calibrated on two storeys
        cal({ id: "d", pdfFileId: "f2", storeyName: "Roof" }), // storey not in the building
        cal({ id: "e", pdfFileId: "f3", storeyName: "L1" }), // other building
        cal({ id: "f", pdfFileId: "f2", storeyName: "L2", projectId: "p2" }), // other project
        cal({ id: "g", pdfFileId: "f2", storeyName: "L1", transformParams: { ...params, scale: 0 } }), // unusable scale
      ],
    });
    expect(out.map((p) => `${p.pdfFileId}:${p.storeyName}:${p.calibration.id}`).sort()).toEqual(["f1:L1:b", "f1:L2:c"]);
  });
});

describe("choosing a plan", () => {
  const plans = sortPlans(
    calibratedPlans({ files, storeys, projectId: "p1", buildingId: "b1", calibrations: [cal({ id: "1", pdfFileId: "f2", storeyName: "L2" }), cal({ id: "2", pdfFileId: "f1", storeyName: "L1" }), cal({ id: "3", pdfFileId: "f1", storeyName: "L2" })] }),
    [{ name: "L1", elevation: 0 }, { name: "L2", elevation: 3 }],
  );
  it("sorts by level elevation", () => {
    expect(plans.map((p) => `${p.storeyName}/${p.name}`)).toEqual(["L1/S-101", "L2/S-101", "L2/S-201"]);
  });
  it("exact plan and storey, else the plan, else the storey, else the first", () => {
    expect(choosePlan(plans, { plan: "f1", storey: "L2" })).toMatchObject({ pdfFileId: "f1", storeyName: "L2" });
    expect(choosePlan(plans, { plan: "f2" })).toMatchObject({ pdfFileId: "f2", storeyName: "L2" });
    expect(choosePlan(plans, { plan: "zzz", storey: "L2" })).toMatchObject({ storeyName: "L2" });
    expect(choosePlan(plans, {})).toMatchObject({ pdfFileId: "f1", storeyName: "L1" });
    expect(choosePlan([], {})).toBeNull();
  });
  it("plansForStorey", () => {
    expect(plansForStorey(plans, "L2").map((p) => p.pdfFileId)).toEqual(["f1", "f2"]);
    expect(plansForStorey(plans, "L9")).toEqual([]);
  });
});

describe("levels", () => {
  it("levelOf takes the lowest elevation of a name repeated by several models", () => {
    const rows = [{ name: "L2", elevation: 284.4, sourceIfcFileId: "a" }, { name: "L2", elevation: 2.84, sourceIfcFileId: "b" }, { name: "L1", elevation: 0, sourceIfcFileId: "a" }] as never;
    expect(levelOf(rows, "L2")?.elevation).toBeCloseTo(2.84);
    expect(levelOf(rows, "Nope")).toBeNull();
  });
  it("storeyBand runs up to the next level, nominal 4 m on the top one", () => {
    const lv = [{ name: "L1", elevation: 0 }, { name: "L2", elevation: 3 }];
    expect(storeyBand(lv, 0)).toEqual({ lo: -0.3, hi: 2.7 });
    expect(storeyBand(lv, 3)).toEqual({ lo: 2.7, hi: 7 });
  });
});

describe("task pins in both panes", () => {
  const c = cal({ id: "c", pdfFileId: "f1", storeyName: "L1" });
  const page = { width: 1000, height: 800 };
  const levels = [{ name: "L1", elevation: 0 }, { name: "L2", elevation: 3 }];
  const bim = (id: string, num: number, p: [number, number, number], extra: object = {}) => ({ id, num, title: `T${num}`, status: 1, pending: false, buildingId: "b1", location: { bim: { worldPoint: p, elements: [] } }, ...extra });
  it("a 3D task on this storey inside the page shows on the plan at its calibrated position", () => {
    const w = worldFromPage(params, { x: 400, y: 200 });
    const pins = planPinsFromModel([bim("t1", 1, [w.x, 1.2, w.z])] as never, { calibration: c, page, floorY: 0, levels, buildingId: "b1", pdfFileId: "f1", versionId: "v1" });
    expect(pins).toHaveLength(1);
    expect(pins[0].uv[0]).toBeCloseTo(0.4, 6);
    expect(pins[0].uv[1]).toBeCloseTo(0.25, 6);
    expect(pins[0].onEarlierRevision).toBe(false);
  });
  it("not on other storeys, outside the page, or in another building", () => {
    const w = worldFromPage(params, { x: 400, y: 200 });
    const far = worldFromPage(params, { x: 5000, y: 200 });
    const tasks = [bim("up", 1, [w.x, 4.5, w.z]), bim("out", 2, [far.x, 1.2, far.z]), bim("other", 3, [w.x, 1.2, w.z], { buildingId: "b2" })];
    expect(planPinsFromModel(tasks as never, { calibration: c, page, floorY: 0, levels, buildingId: "b1", pdfFileId: "f1", versionId: "v1" })).toEqual([]);
  });
  it("a task that already has a plan position on this plan is left to the plan's own pins", () => {
    const w = worldFromPage(params, { x: 400, y: 200 });
    const t = bim("t1", 1, [w.x, 1.2, w.z], { location: { bim: { worldPoint: [w.x, 1.2, w.z], elements: [] }, pdf: { pdfFileId: "f1", page: 1, uv: [0.4, 0.25], calibId: "c" } } });
    expect(planPinsFromModel([t] as never, { calibration: c, page, floorY: 0, levels, buildingId: "b1", pdfFileId: "f1", versionId: "v1" })).toEqual([]);
  });
  it("a plan-only task is placed in 3D at the calibrated point, a pin height above the floor", () => {
    const pin: PlanPin = { taskId: "p1", num: 4, title: "Crack", status: 1, pending: true, uv: [0.4, 0.25], onEarlierRevision: false, revision: { kind: "current" } };
    const old: PlanPin = { ...pin, taskId: "p2", onEarlierRevision: true, revision: { kind: "earlier", number: 1, versionId: "v0" } };
    const legacy: PlanPin = { ...pin, taskId: "p3", onEarlierRevision: true, revision: { kind: "unknown", legacy: true } };
    const out = modelPinsFromPlan([pin, old, legacy], { calibration: c, page, floorY: 2.8, buildingId: "b1" }, new Set());
    expect(out.map((o) => o.taskId)).toEqual(["p1", "p3"]);
    const w = worldFromPage(params, { x: 400, y: 200 });
    expect(out[0].worldPoint[0]).toBeCloseTo(w.x, 6);
    expect(out[0].worldPoint[1]).toBeCloseTo(4, 6);
    expect(out[0].worldPoint[2]).toBeCloseTo(w.z, 6);
    expect(out[0].pending).toBe(true);
    expect(modelPinsFromPlan([pin], { calibration: c, page, floorY: 0, buildingId: "b1" }, new Set(["p1"]))).toEqual([]);
  });
});
