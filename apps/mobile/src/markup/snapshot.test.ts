import { describe, expect, it } from "vitest";
import { captureScale, pinRegion } from "./snapshot";

const A1 = { width: 2384, height: 1684 };

describe("pinRegion", () => {
  it("is 4:3, centred on the pin and as wide as the finest tiles need for about 2200 px", () => {
    const r = pinRegion([0.5, 0.5], A1, 2); // 2200 / 2 = 1100 pt, inside 30..50 % of 2384
    expect(r.w).toBeCloseTo(1100);
    expect(r.h).toBeCloseTo(1100 * 0.75);
    expect(r.x + r.w / 2).toBeCloseTo(1192);
    expect(r.y + r.h / 2).toBeCloseTo(842);
  });
  it("never goes under 30 % or over 50 % of the page width", () => {
    expect(pinRegion([0.5, 0.5], A1, 8).w).toBeCloseTo(A1.width * 0.3);
    expect(pinRegion([0.5, 0.5], A1, 0.5).w).toBeCloseTo(A1.width * 0.5);
  });
  it("keeps the region on the page at the corners", () => {
    const tl = pinRegion([0, 0], A1, 2);
    expect(tl.x).toBe(0);
    expect(tl.y).toBe(0);
    const br = pinRegion([1, 1], A1, 2);
    expect(br.x + br.w).toBeCloseTo(A1.width);
    expect(br.y + br.h).toBeCloseTo(A1.height);
  });
  it("fits a short page: the height wins", () => {
    const wide = { width: 3000, height: 400 };
    const r = pinRegion([0.5, 0.5], wide, 2);
    expect(r.h).toBe(400);
    expect(r.w).toBeCloseTo(400 * (4 / 3));
  });
});

describe("captureScale", () => {
  it("is capped by the finest tiles and by the long side", () => {
    expect(captureScale({ x: 0, y: 0, w: 1100, h: 825 }, 2)).toBe(2);
    expect(captureScale({ x: 0, y: 0, w: 1100, h: 825 }, 4)).toBeCloseTo(2400 / 1100);
  });
});
