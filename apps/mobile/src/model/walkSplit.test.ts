import { describe, expect, it, vi } from "vitest";
import type { CalibratedPlan } from "../linkview/plans";
import { createWalkerStore, planForWalkLevel } from "./walkSplit";

const levels = [
  { name: "L0", elevation: 0 },
  { name: "L1", elevation: 3.5 },
  { name: "L2", elevation: 7 },
];
const plan = (pdfFileId: string, storeyName: string) => ({ pdfFileId, storeyName, name: pdfFileId, calibration: {} as never }) as CalibratedPlan;

describe("planForWalkLevel", () => {
  const plans = [plan("a", "L0"), plan("b", "L2"), plan("c", "L2")];
  it("picks the plan of the nearest level", () => {
    expect(planForWalkLevel(plans, levels, 0)?.pdfFileId).toBe("a");
    expect(planForWalkLevel(plans, levels, 6.9)?.pdfFileId).toBe("b");
  });
  it("honours the preferred plan of the level", () => {
    expect(planForWalkLevel(plans, levels, 7, "c")?.pdfFileId).toBe("c");
    expect(planForWalkLevel(plans, levels, 7, "a")?.pdfFileId).toBe("b");
  });
  it("is null for a level without a plan or without levels", () => {
    expect(planForWalkLevel(plans, levels, 3.5)).toBeNull();
    expect(planForWalkLevel(plans, [], 0)).toBeNull();
  });
});

describe("createWalkerStore", () => {
  it("notifies on visible changes only", () => {
    const s = createWalkerStore();
    const fn = vi.fn();
    s.subscribe(fn);
    s.set({ x: 0, z: 0, floorY: 0, yaw: 0 });
    s.set({ x: 0.001, z: 0, floorY: 0, yaw: 0 });
    expect(fn).toHaveBeenCalledTimes(1);
    s.set({ x: 1, z: 0, floorY: 0, yaw: 0 });
    s.set({ x: 1, z: 0, floorY: 3.5, yaw: 0 });
    expect(fn).toHaveBeenCalledTimes(3);
    s.set(null);
    expect(s.get()).toBeNull();
    expect(fn).toHaveBeenCalledTimes(4);
  });
});
