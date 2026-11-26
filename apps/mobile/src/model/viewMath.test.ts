import { describe, expect, it } from "vitest";
import {
  EYE_HEIGHT,
  cappedPixelRatio,
  choosePinView,
  fitPose,
  floorForY,
  groundFloor,
  walkEntryFloor,
  flyPose,
  focusPose,
  lookBy,
  projectToScreen,
  sectionHeight,
  stepWalk,
  unionBoxes,
  walkFromPose,
  walkPose,
  type CameraPose,
  type WalkState,
} from "./viewMath";

const pose: CameraPose = { pos: [0, 0, 10], target: [0, 0, 0], fov: 90 };

describe("projectToScreen", () => {
  it("puts the look-at point at the viewport centre", () => {
    const s = projectToScreen([0, 0, 0], pose, 800, 600)!;
    expect(s.x).toBeCloseTo(400);
    expect(s.y).toBeCloseTo(300);
    expect(s.depth).toBeCloseTo(10);
    expect(s.onScreen).toBe(true);
  });

  it("maps +X to the right and +Y up (screen y grows downward)", () => {
    const right = projectToScreen([2, 0, 0], pose, 800, 600)!;
    const up = projectToScreen([0, 2, 0], pose, 800, 600)!;
    expect(right.x).toBeGreaterThan(400);
    expect(up.y).toBeLessThan(300);
  });

  it("matches the analytic value for a 90 degree fov", () => {
    // at depth 10 with fov 90, the vertical half-extent is 10 m: a point at y=10 sits on the top edge
    const top = projectToScreen([0, 10, 0], pose, 800, 600)!;
    expect(top.y).toBeCloseTo(0);
    const rightEdge = projectToScreen([10 * (800 / 600), 0, 0], pose, 800, 600)!;
    expect(rightEdge.x).toBeCloseTo(800);
  });

  it("returns null for points behind the camera instead of mirroring them", () => {
    expect(projectToScreen([0, 0, 20], pose, 800, 600)).toBeNull();
    expect(projectToScreen([0, 0, 10], pose, 800, 600)).toBeNull(); // at the eye
  });

  it("flags points outside the viewport, honouring a margin", () => {
    const p = projectToScreen([30, 0, 0], pose, 800, 600)!;
    expect(p.onScreen).toBe(false);
    const edge = projectToScreen([10.7, 0, 0], pose, 800, 600, 20)!; // just past the edge
    expect(edge.onScreen).toBe(true);
  });

  it("survives a straight-down camera (degenerate up vector)", () => {
    const down: CameraPose = { pos: [0, 10, 0], target: [0, 0, 0], fov: 60 };
    const s = projectToScreen([0, 0, 0], down, 400, 400)!;
    expect(s.x).toBeCloseTo(200);
    expect(s.y).toBeCloseTo(200);
  });

  it("rejects an empty viewport", () => {
    expect(projectToScreen([0, 0, 0], pose, 0, 0)).toBeNull();
  });
});

describe("fitPose", () => {
  const box = { min: [-5, 0, -5] as [number, number, number], max: [5, 10, 5] as [number, number, number] };
  it("looks at the box centre and keeps every corner on screen", () => {
    const p = fitPose(box, 45, 1.6);
    expect(p.target).toEqual([0, 5, 0]);
    for (const x of [-5, 5]) for (const y of [0, 10]) for (const z of [-5, 5]) {
      const s = projectToScreen([x, y, z], p, 800, 500)!;
      expect(s, `corner ${x},${y},${z}`).not.toBeNull();
      expect(s.onScreen).toBe(true);
    }
  });
  it("backs off further for a narrow portrait viewport", () => {
    const wide = fitPose(box, 45, 2);
    const tall = fitPose(box, 45, 0.5);
    const d = (p: CameraPose) => Math.hypot(p.pos[0] - p.target[0], p.pos[1] - p.target[1], p.pos[2] - p.target[2]);
    expect(d(tall)).toBeGreaterThan(d(wide));
  });
  it("handles a degenerate (flat/point) box", () => {
    const p = fitPose({ min: [1, 1, 1], max: [1, 1, 1] }, 45, 1);
    expect(p.pos.every(Number.isFinite)).toBe(true);
  });
});

describe("unionBoxes", () => {
  it("merges boxes and skips non-finite ones", () => {
    const u = unionBoxes([
      { min: [0, 0, 0], max: [1, 1, 1] },
      { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] },
      { min: [-2, 0, 0], max: [0, 5, 1] },
      null,
    ]);
    expect(u).toEqual({ min: [-2, 0, 0], max: [1, 5, 1] });
    expect(unionBoxes([null])).toBeNull();
  });
});

describe("focusPose / choosePinView", () => {
  it("keeps the view direction and stands `dist` metres from the point", () => {
    const f = focusPose([4, 1, 2], pose, 5);
    expect(f.target).toEqual([4, 1, 2]);
    expect(f.pos[0]).toBeCloseTo(4);
    expect(f.pos[2]).toBeCloseTo(7); // looking along -Z, so it stands behind (+Z) of the point
  });
  it("uses the stored camera only when it shows the pin", () => {
    const p: [number, number, number] = [0, 0, 0];
    const good: CameraPose = { pos: [0, 0, 8], target: [0, 0, 0], fov: 60 };
    const away: CameraPose = { pos: [0, 0, 8], target: [0, 0, 20], fov: 60 };
    expect(choosePinView(p, good, pose, 800, 600)).toBe(good);
    const flown = choosePinView(p, away, pose, 800, 600);
    expect(flown.target).toEqual(p);
    expect(choosePinView(p, null, pose, 800, 600).target).toEqual(p);
  });
});

describe("first-person walking", () => {
  const s0: WalkState = { x: 0, z: 0, floorY: 3, yaw: 0, pitch: 0 };

  it("puts the eye 1.6 m above the floor and looks forward along -Z at yaw 0", () => {
    const p = walkPose(s0);
    expect(p.pos).toEqual([0, 3 + EYE_HEIGHT, 0]);
    expect(p.target[2]).toBeLessThan(0);
    expect(p.target[1]).toBeCloseTo(p.pos[1]);
  });

  it("walks forward at the given speed and never changes the eye height", () => {
    const s = stepWalk(s0, { forward: 1, strafe: 0 }, 0.2, 2);
    expect(s.z).toBeCloseTo(-0.4);
    expect(s.x).toBeCloseTo(0);
    expect(walkPose(s).pos[1]).toBeCloseTo(4.6);
  });

  it("strafes to the right of the heading and rotates with the yaw", () => {
    expect(stepWalk(s0, { forward: 0, strafe: 1 }, 0.2, 1).x).toBeCloseTo(0.2);
    const turned = stepWalk({ ...s0, yaw: Math.PI / 2 }, { forward: 1, strafe: 0 }, 0.2, 1); // facing +X
    expect(turned.x).toBeCloseTo(0.2);
    expect(turned.z).toBeCloseTo(0);
  });

  it("does not move faster on the diagonal and clamps a stalled frame", () => {
    const d = stepWalk(s0, { forward: 1, strafe: 1 }, 0.2, 1);
    expect(Math.hypot(d.x, d.z)).toBeCloseTo(0.2);
    const stalled = stepWalk(s0, { forward: 1, strafe: 0 }, 5, 1);
    expect(Math.abs(stalled.z)).toBeCloseTo(0.25);
  });

  it("looks by dragging and clamps the pitch", () => {
    const r = lookBy(s0, 100, 0, 0.01);
    expect(r.yaw).toBeCloseTo(1);
    const up = lookBy(s0, 0, -100000);
    expect(up.pitch).toBeLessThan(Math.PI / 2);
    expect(up.pitch).toBeGreaterThan(1.3);
    expect(lookBy(s0, 0, 100000).pitch).toBeLessThan(-1.3);
  });

  it("starts with the heading of the orbit camera", () => {
    const w = walkFromPose({ pos: [0, 10, 0], target: [10, 5, 0] }, { x: 1, z: 2 }, 0);
    expect(w.yaw).toBeCloseTo(Math.PI / 2); // looking along +X
    expect(w).toMatchObject({ x: 1, z: 2, pitch: 0 });
  });
});

describe("storey helpers", () => {
  it("stands on the highest storey at or below the height", () => {
    expect(floorForY([0, 3, 6], 3.2)).toBe(3);
    expect(floorForY([0, 3, 6], 2.9)).toBe(3); // within tolerance of the 3 m floor
    expect(floorForY([0, 3, 6], -5)).toBe(0);
    expect(floorForY([], 1)).toBeNull();
  });
  it("cuts 1.5 m above the floor, but below the next storey", () => {
    expect(sectionHeight([0, 3, 6], 0)).toBeCloseTo(1.5);
    expect(sectionHeight([0, 1, 6], 0)).toBeCloseTo(0.95);
    expect(sectionHeight([0], 0)).toBeCloseTo(1.5);
  });
});

describe("cappedPixelRatio", () => {
  it("caps at 1.5 and tolerates junk", () => {
    expect(cappedPixelRatio(2)).toBe(1.5);
    expect(cappedPixelRatio(3.5)).toBe(1.5);
    expect(cappedPixelRatio(1)).toBe(1);
    expect(cappedPixelRatio(0)).toBe(1);
    expect(cappedPixelRatio(Number.NaN)).toBe(1);
  });
});

describe("flyPose", () => {
  const cur: CameraPose = { pos: [10, 5, 10], target: [0, 0, 0], fov: 45 };
  const box = { min: [4, 1, 4] as [number, number, number], max: [6, 3, 6] as [number, number, number] };
  it("looks at the box centre along the current viewing direction", () => {
    const p = flyPose(box, cur, 1.6);
    expect(p.target).toEqual([5, 2, 5]);
    const before = [cur.pos[0] - cur.target[0], cur.pos[1] - cur.target[1], cur.pos[2] - cur.target[2]];
    const after = [p.pos[0] - p.target[0], p.pos[1] - p.target[1], p.pos[2] - p.target[2]];
    const cos = (before[0] * after[0] + before[1] * after[1] + before[2] * after[2]) / (Math.hypot(...before) * Math.hypot(...after));
    expect(cos).toBeCloseTo(1);
    expect(p.fov).toBe(45);
  });
  it("backs off further for a bigger element and never closer than the minimum", () => {
    const small = flyPose({ min: [0, 0, 0], max: [0.1, 0.1, 0.1] }, cur, 1.6);
    const big = flyPose({ min: [0, 0, 0], max: [20, 5, 20] }, cur, 1.6);
    const d = (p: CameraPose) => Math.hypot(p.pos[0] - p.target[0], p.pos[1] - p.target[1], p.pos[2] - p.target[2]);
    expect(d(small)).toBeCloseTo(1.5);
    expect(d(big)).toBeGreaterThan(d(small) * 5);
  });
  it("copes with a camera sitting on its target", () => {
    const p = flyPose(box, { pos: [0, 0, 0], target: [0, 0, 0], fov: 45 }, 1.6);
    expect(p.pos.every(Number.isFinite)).toBe(true);
  });
});

describe("walk entry floor", () => {
  it("the ground storey is the elevation closest to 0", () => {
    expect(groundFloor([-3.2, 0, 3, 6])).toBe(0);
    expect(groundFloor([0.15, 3.2, 6.4])).toBe(0.15);
    expect(groundFloor([-3, 3])).toBe(-3);
    expect(groundFloor([])).toBeNull();
  });
  it("from above the building (fit view) the walk starts on the ground storey, not the roof", () => {
    expect(walkEntryFloor([-3.2, 0, 3, 6, 9], 9.4, 40, 10)).toBe(0);
  });
  it("from inside or beside the building it stands under the point the view looks at", () => {
    expect(walkEntryFloor([0, 3, 6, 9], 6.2, 7.6, 10)).toBe(6);
    expect(walkEntryFloor([0, 3, 6], 3.1, 2, null)).toBe(3);
  });
});
