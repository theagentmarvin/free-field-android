import { describe, expect, it } from "vitest";
import { loupePlacement, loupeSource } from "./loupe";

describe("loupe placement", () => {
  const bounds = { w: 800, h: 600 };
  it("sits above the finger", () => {
    const p = loupePlacement({ x: 400, y: 400 }, bounds, 116);
    expect(p.below).toBe(false);
    expect(p.y).toBeLessThan(400 - 58);
  });
  it("flips below near the top edge and clamps sideways", () => {
    const p = loupePlacement({ x: 3, y: 40 }, bounds, 116);
    expect(p.below).toBe(true);
    expect(p.y).toBeGreaterThan(40);
    expect(p.x).toBeGreaterThanOrEqual(62);
    expect(loupePlacement({ x: 799, y: 300 }, bounds, 116).x).toBeLessThanOrEqual(800 - 62);
  });
  it("never covers the aimed point", () => {
    for (const y of [10, 80, 150, 300, 590]) {
      const p = loupePlacement({ x: 400, y }, bounds, 116);
      expect(Math.hypot(p.x - 400, p.y - y)).toBeGreaterThan(58);
    }
  });
});

describe("loupe source rectangle", () => {
  it("is centred on the aim and scaled to bitmap pixels", () => {
    const s = loupeSource({ x: 100, y: 100 }, { w: 400, h: 300 }, { w: 800, h: 600 }, 116, 3);
    expect(s.sw).toBeCloseTo((116 / 3) * 2, 9);
    expect(s.sx + s.sw / 2).toBeCloseTo(200, 9);
    expect(s.sy + s.sw / 2).toBeCloseTo(200, 9);
  });
  it("stays inside the bitmap", () => {
    const s = loupeSource({ x: 0, y: 299 }, { w: 400, h: 300 }, { w: 400, h: 300 }, 116, 3);
    expect(s.sx).toBe(0);
    expect(s.sy + s.sw).toBeLessThanOrEqual(300 + 1e-9);
  });
});
