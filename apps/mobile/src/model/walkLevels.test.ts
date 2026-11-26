import { describe, expect, it } from "vitest";
import { levelIndexFor, stepLevel, walkLevels, withLevel } from "./walkLevels";
import { walkPose, type WalkState } from "./viewMath";

const chips = [
  { name: "Roof", elevation: 6.1 },
  { name: "Ground", elevation: 0 },
  { name: "Level 2", elevation: 2.84 },
  { name: "Broken", elevation: Number.NaN },
];
const levels = walkLevels(chips);

describe("walk levels", () => {
  it("sorts lowest first and drops storeys without an elevation", () => {
    expect(levels.map((l) => l.name)).toEqual(["Ground", "Level 2", "Roof"]);
  });
  it("finds the level the walker stands on", () => {
    expect(levelIndexFor(levels, 2.84)).toBe(1);
    expect(levelIndexFor(levels, 2.5)).toBe(1);
    expect(levelIndexFor([], 0)).toBe(-1);
  });
  it("steps up and down, null at the ends", () => {
    expect(stepLevel(levels, 0, 1)?.name).toBe("Level 2");
    expect(stepLevel(levels, 2.84, -1)?.name).toBe("Ground");
    expect(stepLevel(levels, 0, -1)).toBeNull();
    expect(stepLevel(levels, 6.1, 1)).toBeNull();
  });
  it("a level change moves the eye to elevation + 1.6 m and keeps x/z and heading", () => {
    const s: WalkState = { x: 4, z: -7, floorY: 0, yaw: 1.2, pitch: -0.1 };
    const t = withLevel(s, levels[1]);
    const p = walkPose(t);
    expect(p.pos).toEqual([4, 2.84 + 1.6, -7]);
    expect(t.yaw).toBe(1.2);
    expect(t.pitch).toBe(-0.1);
  });
});
