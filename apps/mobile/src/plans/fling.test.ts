import { describe, expect, it } from "vitest";
import { FLING_MAX_SPEED, flingDistance, flingStep, releaseVelocity } from "./fling";

describe("releaseVelocity", () => {
  it("is the speed over the last 100 ms", () => {
    const s = [
      { x: 0, y: 0, t: 0 }, // older than the window: ignored
      { x: 100, y: 0, t: 500 },
      { x: 130, y: 6, t: 530 },
      { x: 160, y: 12, t: 560 },
    ];
    const v = releaseVelocity(s, 565);
    expect(v.vx).toBeCloseTo(1, 5);
    expect(v.vy).toBeCloseTo(0.2, 5);
  });
  it("does not fling after a pause, with one sample, or when too slow", () => {
    const s = [{ x: 0, y: 0, t: 0 }, { x: 50, y: 0, t: 20 }];
    expect(releaseVelocity(s, 400)).toEqual({ vx: 0, vy: 0 });
    expect(releaseVelocity([s[0]], 10)).toEqual({ vx: 0, vy: 0 });
    expect(releaseVelocity([{ x: 0, y: 0, t: 0 }, { x: 0.1, y: 0, t: 50 }], 55)).toEqual({ vx: 0, vy: 0 });
  });
  it("caps absurd speeds", () => {
    const v = releaseVelocity([{ x: 0, y: 0, t: 0 }, { x: 5000, y: 0, t: 10 }], 11);
    expect(Math.hypot(v.vx, v.vy)).toBeCloseTo(FLING_MAX_SPEED, 5);
  });
});

describe("flingStep", () => {
  it("is frame-rate independent and converges to the analytic distance", () => {
    const v0 = { vx: 2, vy: -1 };
    const run = (dt: number) => {
      let v = v0;
      let x = 0;
      let y = 0;
      for (let i = 0; i < 100000; i++) {
        const s = flingStep(v, dt);
        x += s.dx;
        y += s.dy;
        v = s.v;
        if (s.done) break;
      }
      return { x, y };
    };
    const a = run(8);
    const b = run(33);
    expect(a.x).toBeCloseTo(b.x, 0);
    const total = flingDistance(v0);
    expect(a.x).toBeGreaterThan(total.dx * 0.97);
    expect(a.x).toBeLessThanOrEqual(total.dx);
    expect(a.y).toBeLessThan(0);
  });
  it("stops once slow", () => {
    expect(flingStep({ vx: 0.021, vy: 0 }, 500).done).toBe(true);
    expect(flingStep({ vx: 3, vy: 0 }, 16).done).toBe(false);
  });
});
