import { describe, expect, it } from "vitest";
import { applyCalibration, computeSimilarityTransform } from "@ff/data/calibration/similarity";
import type { CalibrationRecord } from "@ff/types";
import { bearingFromYaw, clampToPage, insidePage, markerFromWalker, pageFromWorld, pageHeadingFromYaw, seedWalker, walkerChanged, walkerFromPage, worldFromPage, wrapAngle, yawFromBearing, yawFromPageHeading } from "./sync";
import { walkForward } from "../model/viewMath";

// The demo S-101 calibration (a small rotation) and a 90 degree one.
const demo = { scale: 0.033983052125696425, rotation: 0.00395249126410087, translateX: -10.922044471609226, translateZ: -13.816282128605584 };
const rot90 = computeSimilarityTransform({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 5, z: 5 }, { x: 5, z: 15 }); // page +x -> world +z

describe("page <-> world", () => {
  it("round trips through the calibration", () => {
    for (const p of [{ x: 0, y: 0 }, { x: 226.7, y: 303.7 }, { x: 800, y: 560 }]) {
      const w = worldFromPage(demo, p);
      const back = pageFromWorld(demo, w);
      expect(back.x).toBeCloseTo(p.x, 6);
      expect(back.y).toBeCloseTo(p.y, 6);
    }
  });
  it("the calibration anchors land where the calibration says", () => {
    const w = worldFromPage(demo, { x: 226.75679837740384, y: 303.6965895432692 });
    expect(w.x).toBeCloseTo(-3.257, 2);
    expect(w.z).toBeCloseTo(-3.465, 2);
  });
  it("insidePage and clampToPage", () => {
    const pg = { width: 100, height: 50 };
    expect(insidePage({ x: 10, y: 10 }, pg)).toBe(true);
    expect(insidePage({ x: 101, y: 10 }, pg)).toBe(false);
    expect(insidePage({ x: 101, y: 10 }, pg, 2)).toBe(true);
    expect(clampToPage({ x: -5, y: 70 }, pg)).toEqual({ x: 0, y: 50 });
  });
});

describe("heading conventions", () => {
  it("yaw 0 (looks along -Z) is bearing -90 degrees; yaw 90 degrees (looks along +X) is bearing 0", () => {
    expect(bearingFromYaw(0)).toBeCloseTo(-Math.PI / 2);
    expect(bearingFromYaw(Math.PI / 2)).toBeCloseTo(0);
    expect(yawFromBearing(0)).toBeCloseTo(Math.PI / 2);
  });
  it("the bearing of the walk direction is atan2(dz, dx) for every yaw", () => {
    for (const yaw of [0, 0.7, 1.9, -2.4, 3.0]) {
      const f = walkForward(yaw);
      expect(wrapAngle(bearingFromYaw(yaw) - Math.atan2(f[2], f[0]))).toBeCloseTo(0, 9);
    }
  });
  it("page heading <-> yaw round trips for any calibration", () => {
    for (const params of [demo, rot90]) {
      for (const yaw of [0, 1, -2, 3.1]) {
        expect(wrapAngle(yawFromPageHeading(params, pageHeadingFromYaw(params, yaw)) - yaw)).toBeCloseTo(0, 9);
      }
    }
  });
  it("a heading on the page is the world direction it maps to: walking that way moves along the page heading", () => {
    // A point one page unit along the heading maps to a world point in the walk direction of the yaw.
    for (const params of [demo, rot90]) {
      for (const heading of [0, 0.9, -1.4, 2.6]) {
        const yaw = yawFromPageHeading(params, heading);
        const f = walkForward(yaw);
        const a = applyCalibration(params, { x: 10, y: 10 });
        const b = applyCalibration(params, { x: 10 + Math.cos(heading), y: 10 + Math.sin(heading) });
        const d = Math.hypot(b.x - a.x, b.z - a.z);
        expect((b.x - a.x) / d).toBeCloseTo(f[0], 6);
        expect((b.z - a.z) / d).toBeCloseTo(f[2], 6);
      }
    }
  });
  it("rot90: page +x is world +z, so looking along page +x is looking along +Z", () => {
    expect(rot90.rotation).toBeCloseTo(Math.PI / 2, 6);
    const yaw = yawFromPageHeading(rot90, 0);
    const f = walkForward(yaw);
    expect(f[0]).toBeCloseTo(0, 6);
    expect(f[2]).toBeCloseTo(1, 6);
  });
});

describe("walker <-> marker", () => {
  it("a tap on the page stands the walker on the calibrated world point, keeping the heading", () => {
    const heading = 0.5;
    const w = walkerFromPage(demo, 2.8, { x: 300, y: 200 }, heading);
    const expected = worldFromPage(demo, { x: 300, y: 200 });
    expect(w.x).toBeCloseTo(expected.x);
    expect(w.z).toBeCloseTo(expected.z);
    expect(w.floorY).toBe(2.8);
    const m = markerFromWalker(demo, w);
    expect(m.page.x).toBeCloseTo(300, 6);
    expect(m.page.y).toBeCloseTo(200, 6);
    expect(wrapAngle(m.heading - heading)).toBeCloseTo(0, 9);
  });
  it("walkerChanged ignores noise and reports real moves, turns and level changes", () => {
    const a = { x: 1, z: 2, floorY: 0, yaw: 0.3 };
    expect(walkerChanged(null, a)).toBe(true);
    expect(walkerChanged(a, { ...a, x: 1.005 })).toBe(false);
    expect(walkerChanged(a, { ...a, yaw: 0.3 + 0.004 })).toBe(false);
    expect(walkerChanged(a, { ...a, x: 1.05 })).toBe(true);
    expect(walkerChanged(a, { ...a, yaw: 0.4 })).toBe(true);
    expect(walkerChanged(a, { ...a, floorY: 3 })).toBe(true);
    expect(walkerChanged({ ...a, yaw: Math.PI - 0.001 }, { ...a, yaw: -Math.PI + 0.001 })).toBe(false); // the same direction across the wrap
  });
});

describe("seedWalker", () => {
  const rec = (pairs: Array<[number, number]>): Pick<CalibrationRecord, "pointPairs"> => ({ pointPairs: pairs.map(([x, z]) => ({ pdfX: 0, pdfY: 0, worldX: x, worldZ: z })) as CalibrationRecord["pointPairs"] });
  it("starts at the first anchor looking toward the second", () => {
    const w = seedWalker(rec([[1, 1], [11, 1]]), 3); // toward +x
    expect(w).toMatchObject({ x: 1, z: 1, floorY: 3 });
    const f = walkForward(w.yaw);
    expect(f[0]).toBeCloseTo(1, 6);
    expect(f[2]).toBeCloseTo(0, 6);
  });
  it("coinciding or missing anchors never produce NaN", () => {
    expect(seedWalker(rec([[1, 1], [1, 1]]), 0).yaw).toBe(0);
    expect(seedWalker({ pointPairs: [] as never }, 0)).toEqual({ x: 0, z: 0, floorY: 0, yaw: 0 });
  });
});
