import { describe, expect, it } from "vitest";
import { canFinish3d, hintFor, PlacedPoints } from "./measureState";

describe("3D measure draft state", () => {
  it("finish needs 3 area corners, 1 volume item and never applies to length or angle", () => {
    expect(canFinish3d("area", 2)).toBe(false);
    expect(canFinish3d("area", 3)).toBe(true);
    expect(canFinish3d("volume", 0)).toBe(false);
    expect(canFinish3d("volume", 1)).toBe(true);
    expect(canFinish3d("length", 1)).toBe(false);
    expect(canFinish3d("angle", 2)).toBe(false);
  });
  it("length completes on its second point and angle on its third", () => {
    const l = new PlacedPoints<number>("length");
    l.push(1);
    expect(l.completed()).toBe(false);
    l.push(2);
    expect(l.completed()).toBe(true);
    const a = new PlacedPoints<number>("angle");
    a.push(1);
    a.push(2);
    expect(a.completed()).toBe(false);
    a.push(3);
    expect(a.completed()).toBe(true);
    const ar = new PlacedPoints<number>("area");
    for (let i = 0; i < 5; i++) ar.push(i);
    expect(ar.completed()).toBe(false);
  });
  it("undo returns the points that remain to be replayed", () => {
    const a = new PlacedPoints<string>("area");
    a.push("a");
    a.push("b");
    a.push("c");
    expect(a.undo()).toEqual(["a", "b"]);
    expect(a.count).toBe(2);
    expect(a.undo()).toEqual(["a"]);
    expect(a.undo()).toEqual([]);
    expect(a.undo()).toEqual([]);
    expect(a.count).toBe(0);
  });
  it("hints follow the number of placed points", () => {
    expect(hintFor("angle", 1)).toMatch(/corner/);
    expect(hintFor("area", 3)).toMatch(/Finish/);
    expect(hintFor("length", 1)).toMatch(/second/);
  });
});
