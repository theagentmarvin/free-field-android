import { describe, expect, it } from "vitest";
import { applyCalibration } from "@ff/data/calibration/similarity";
import { UNCALIBRATED_CALIB_ID } from "@ff/types";
import { isLinkviewLocation } from "@ff/tasks";
import { pdfPinLocation } from "@ff/tasks-react";
import { POINT_HEIGHT, withModelPoint, worldPointForPin, type DualInput } from "./dualLocation";

const params = { scale: 0.02, rotation: 0.4, translateX: 12, translateZ: -7 };
const calib = { id: "c1", storeyName: "Level 1", transformParams: params, updatedAt: 1 };
const PAGE = { width: 2000, height: 1000 };
const input = (o: Partial<DualInput> = {}): DualInput => ({ calibration: calib, page: PAGE, floorY: 3.5, ...o });
const pin = (uv: [number, number] = [0.25, 0.75], page = 1) => pdfPinLocation("f1", page, uv, calib, "v1");

describe("3D point of a plan pin", () => {
  it("is the pin's page position through the calibration, at the floor plus the pin height", () => {
    const p = worldPointForPin({ page: 1, uv: [0.25, 0.75] }, input())!;
    const w = applyCalibration(params, { x: 500, y: 750 });
    expect(p[0]).toBeCloseTo(w.x, 9);
    expect(p[2]).toBeCloseTo(w.z, 9);
    expect(p[1]).toBeCloseTo(3.5 + POINT_HEIGHT, 9);
  });

  it.each([
    ["no calibration", { calibration: null }],
    ["the uncalibrated sentinel", { calibration: { ...calib, id: UNCALIBRATED_CALIB_ID } }],
    ["an unusable scale", { calibration: { ...calib, transformParams: { ...params, scale: 0 } } }],
    ["no page size", { page: null }],
    ["no storey floor", { floorY: null }],
  ])("is null with %s", (_n, o) => {
    expect(worldPointForPin({ page: 1, uv: [0.5, 0.5] }, input(o as Partial<DualInput>))).toBeNull();
  });

  it("is null off page 1 (calibrations belong to the first page) or off the page", () => {
    expect(worldPointForPin({ page: 2, uv: [0.5, 0.5] }, input())).toBeNull();
    expect(worldPointForPin({ page: 1, uv: [1.2, 0.5] }, input())).toBeNull();
  });
});

describe("withModelPoint", () => {
  it("adds the web's dual shape: pdf kept, bim with a world point and no elements or camera, origin linkview", () => {
    const loc = withModelPoint(pin(), input());
    expect(loc.pdf).toEqual(pin().pdf);
    expect(loc.bim).toEqual({ elements: [], worldPoint: worldPointForPin({ page: 1, uv: [0.25, 0.75] }, input()), cameraPose: null });
    expect(loc.origin).toBe("linkview");
    expect(loc.storeyName).toBe("Level 1");
    expect(isLinkviewLocation(loc)).toBe(true);
  });
  it("leaves an uncalibrated pin plan-only, exactly as before", () => {
    const un = pdfPinLocation("f1", 1, [0.5, 0.5], { ...calib, id: UNCALIBRATED_CALIB_ID, storeyName: "" }, "v1");
    expect(withModelPoint(un, input({ calibration: { ...calib, id: UNCALIBRATED_CALIB_ID } }))).toBe(un);
    const loc = withModelPoint(pin(), input({ floorY: null }));
    expect(loc.bim).toBeNull();
    expect(loc.origin).toBeUndefined();
  });
  it("does not touch a location that already has a 3D part, or has no plan pin", () => {
    const has = { ...pin(), bim: { elements: [], worldPoint: [1, 2, 3] as [number, number, number], cameraPose: null } };
    expect(withModelPoint(has, input())).toBe(has);
    const bimOnly = { storeyName: null, bim: has.bim, pdf: null };
    expect(withModelPoint(bimOnly, input())).toBe(bimOnly);
  });
});
