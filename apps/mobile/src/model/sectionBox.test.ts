import { describe, expect, it } from "vitest";
import { axisPlane, boxAround, boxPlanes, clampBox, defaultOffset, diffPlanes, dominantAxis, keepsPoint, sectionPlanes, setBoxEdge, viewBox, type PlaneData } from "./sectionBox";
import type { Box } from "./viewMath";

const BOX: Box = { min: [0, 0, 0], max: [10, 3, 6] };

describe("boxPlanes", () => {
  it("has six faces that keep exactly the inside of the box", () => {
    const planes = boxPlanes(BOX);
    expect(planes).toHaveLength(6);
    expect(keepsPoint(planes, [5, 1.5, 3])).toBe(true);
    expect(keepsPoint(planes, [0, 0, 0])).toBe(true); // corners are on the faces
    for (const outside of [[-0.5, 1, 3], [10.5, 1, 3], [5, -0.1, 3], [5, 3.1, 3], [5, 1, -1], [5, 1, 6.2]] as const) {
      expect(keepsPoint(planes, [...outside]), `outside ${outside}`).toBe(false);
    }
  });

  it("orders the faces x-min, x-max, y-min, y-max, z-min, z-max with inward normals", () => {
    const [a, b, c, d, e, f] = boxPlanes(BOX);
    expect([a.normal.x, b.normal.x, c.normal.y, d.normal.y, e.normal.z, f.normal.z]).toEqual([1, -1, 1, -1, 1, -1]);
    expect([a.point.x, b.point.x, c.point.y, d.point.y, e.point.z, f.point.z]).toEqual([0, 10, 0, 3, 0, 6]);
  });
});

describe("setBoxEdge / clampBox", () => {
  const bounds: Box = { min: [-1, -1, -1], max: [11, 4, 7] };
  it("moves one face and never crosses the opposite one", () => {
    expect(setBoxEdge(BOX, "x", "min", 4, bounds).min[0]).toBe(4);
    expect(setBoxEdge(BOX, "x", "min", 99, bounds, 0.1).min[0]).toBeCloseTo(9.9);
    expect(setBoxEdge(BOX, "y", "max", -5, bounds, 0.1).max[1]).toBeCloseTo(0.1);
  });
  it("stays inside the slider bounds", () => {
    expect(setBoxEdge(BOX, "z", "max", 100, bounds).max[2]).toBe(7);
    expect(setBoxEdge(BOX, "z", "min", -100, bounds).min[2]).toBe(-1);
  });
  it("clamps a box that sticks out and repairs inverted or collapsed sides", () => {
    const c = clampBox({ min: [-5, 2, 3], max: [20, 2, 1] }, bounds);
    expect(c.min[0]).toBe(-1);
    expect(c.max[0]).toBe(11);
    expect(c.max[1] - c.min[1]).toBeGreaterThanOrEqual(0.1 - 1e-9);
    expect(c.min[2]).toBe(1);
    expect(c.max[2]).toBe(3);
  });
});

describe("viewBox / boxAround", () => {
  const pose = { pos: [20, 10, 20] as [number, number, number], target: [5, 1, 3] as [number, number, number], fov: 45 };
  it("is centred on the look-at point and clipped to the models", () => {
    const b = viewBox(pose, BOX)!;
    expect(b).not.toBeNull();
    expect(keepsPoint(boxPlanes(b), [5, 1, 3])).toBe(true);
    for (let i = 0; i < 3; i++) {
      expect(b.min[i]).toBeGreaterThanOrEqual(BOX.min[i]);
      expect(b.max[i]).toBeLessThanOrEqual(BOX.max[i]);
    }
  });
  it("is null for a camera sitting on its target and for an empty model", () => {
    expect(viewBox({ ...pose, pos: pose.target }, BOX)).toBeNull();
    expect(viewBox(pose, { min: [NaN, 0, 0], max: [1, 1, 1] })).toBeNull();
  });
  it("pads an element box on every side", () => {
    const e = boxAround({ min: [1, 1, 1], max: [2, 2, 2] }, 0.5);
    expect(e).toEqual({ min: [0.5, 0.5, 0.5], max: [2.5, 2.5, 2.5] });
  });
});

describe("axis planes", () => {
  it("keeps the lower side by default and the upper side when flipped", () => {
    const low = axisPlane({ axis: "y", offset: 2, flipped: false }, [0, 0, 0]);
    expect(keepsPoint([low], [0, 1, 0])).toBe(true);
    expect(keepsPoint([low], [0, 3, 0])).toBe(false);
    const up = axisPlane({ axis: "y", offset: 2, flipped: true }, [0, 0, 0]);
    expect(keepsPoint([up], [0, 1, 0])).toBe(false);
    expect(keepsPoint([up], [0, 3, 0])).toBe(true);
  });
  it("defaults to the middle of the bounds", () => {
    expect(defaultOffset("x", BOX)).toBe(5);
    expect(defaultOffset("y", BOX)).toBe(1.5);
  });
  it("picks the axis the camera looks along most", () => {
    expect(dominantAxis({ pos: [0, 10, 0], target: [0, 0, 1] })).toBe("y");
    expect(dominantAxis({ pos: [0, 1, 0], target: [5, 1, 1] })).toBe("x");
    expect(dominantAxis({ pos: [0, 1, 0], target: [1, 1, 5] })).toBe("z");
  });
});

describe("sectionPlanes combines the box and the single planes", () => {
  it("lists the six faces first, then the planes; a point must pass all of them", () => {
    const planes = sectionPlanes({ box: BOX, planes: [{ axis: "x", offset: 4, flipped: false }] }, BOX);
    expect(planes).toHaveLength(7);
    expect(keepsPoint(planes, [2, 1, 1])).toBe(true);
    expect(keepsPoint(planes, [6, 1, 1])).toBe(false); // inside the box but cut by the x plane
    expect(sectionPlanes({ box: null, planes: [] }, BOX)).toEqual([]);
  });
});

describe("diffPlanes", () => {
  const a: PlaneData = { point: { x: 0, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 } };
  const b: PlaneData = { point: { x: 1, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 } };
  const c: PlaneData = { point: { x: 0, y: 2, z: 0 }, normal: { x: 0, y: -1, z: 0 } };
  it("does nothing for equal sets", () => expect(diffPlanes([a, c], [a, c])).toEqual([]));
  it("updates changed planes in place", () => expect(diffPlanes([a, c], [b, c])).toEqual([{ op: "update", index: 0, plane: b }]));
  it("adds missing planes", () => expect(diffPlanes([a], [a, b, c])).toEqual([{ op: "add", plane: b }, { op: "add", plane: c }]));
  it("removes surplus planes from the end so indices stay valid", () => expect(diffPlanes([a, b, c], [a])).toEqual([{ op: "remove", index: 2 }, { op: "remove", index: 1 }]));
  it("updates before it adds", () => expect(diffPlanes([a], [b, c])).toEqual([{ op: "update", index: 0, plane: b }, { op: "add", plane: c }]));
});
