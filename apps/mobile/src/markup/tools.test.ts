import { describe, expect, it } from "vitest";
import { isFreehandTool, isPalmContact, isTwoPointTool, MAX_STROKE_POINTS, MIN_SHAPE_PX, strokeToShape, StrokeGesture, textShape, twoPointShape } from "./tools";

const PAGE = { width: 1000, height: 500 };

describe("strokeToShape", () => {
  const dense = Array.from({ length: 1500 }, (_, i) => ({ x: 100 + i * 0.4, y: 200 + Math.sin(i / 40) * 30 }));
  it("shrinks a dense stroke a lot and keeps its ends", () => {
    const s = strokeToShape(dense, 1, PAGE);
    expect(s.pts.length).toBeLessThan(120);
    expect(s.pts.length).toBeGreaterThan(5);
    expect(s.pts[0][0]).toBeCloseTo(0.1);
    expect(s.pts[s.pts.length - 1][0]).toBeCloseTo((100 + 1499 * 0.4) / 1000);
  });
  it("is finer when drawn zoomed in (tolerance is in screen pixels)", () => {
    expect(strokeToShape(dense, 8, PAGE).pts.length).toBeGreaterThan(strokeToShape(dense, 0.5, PAGE).pts.length);
  });
  it("never exceeds the point cap and stays inside the page", () => {
    const wild = Array.from({ length: 6000 }, (_, i) => ({ x: -50 + ((i * 7919) % 1200), y: -20 + ((i * 104729) % 600) }));
    const s = strokeToShape(wild, 20, PAGE);
    expect(s.pts.length).toBeLessThanOrEqual(MAX_STROKE_POINTS);
    for (const [u, v] of s.pts) {
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThanOrEqual(1);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
  it("a tap makes a one-point dot", () => {
    expect(strokeToShape([{ x: 500, y: 250 }], 1, PAGE).pts).toEqual([[0.5, 0.5]]);
  });
});

describe("two-point and text shapes", () => {
  it("accepts a deliberate drag, rejects a tap-sized one (screen pixels, so zoom matters)", () => {
    expect(twoPointShape({ x: 100, y: 100 }, { x: 300, y: 200 }, 1, PAGE)).toEqual({ pts: [[0.1, 0.2], [0.3, 0.4]] });
    expect(twoPointShape({ x: 100, y: 100 }, { x: 103, y: 100 }, 1, PAGE)).toBeNull();
    expect(twoPointShape({ x: 100, y: 100 }, { x: 103, y: 100 }, MIN_SHAPE_PX, PAGE)).not.toBeNull();
  });
  it("clamps to the page", () => {
    expect(twoPointShape({ x: -10, y: 100 }, { x: 1200, y: 800 }, 1, PAGE)!.pts).toEqual([[0, 0.2], [1, 1]]);
  });
  it("text keeps the trimmed content and the size", () => {
    expect(textShape({ x: 250, y: 100 }, "  Fix this  ", 0.016, PAGE)).toEqual({ pts: [[0.25, 0.2]], text: "Fix this", size: 0.016 });
  });
  it("classifies the tools", () => {
    expect(isTwoPointTool("rect")).toBe(true);
    expect(isTwoPointTool("pen")).toBe(false);
    expect(isFreehandTool("highlight")).toBe(true);
    expect(isFreehandTool("text")).toBe(false);
  });
});

describe("palm rejection", () => {
  it("rejects a touch with a large contact patch in either direction", () => {
    expect(isPalmContact({ pointerType: "touch", width: 90, height: 30 })).toBe(true);
    expect(isPalmContact({ pointerType: "touch", width: 20, height: 120 })).toBe(true);
  });
  it("accepts a fingertip", () => {
    expect(isPalmContact({ pointerType: "touch", width: 24, height: 28 })).toBe(false);
  });
  it("never rejects a pen or a mouse, whatever the size", () => {
    expect(isPalmContact({ pointerType: "pen", width: 200, height: 200 })).toBe(false);
    expect(isPalmContact({ pointerType: "mouse", width: 200, height: 200 })).toBe(false);
  });
  it("accepts when the contact size is unavailable (0, 1, missing, NaN)", () => {
    expect(isPalmContact({ pointerType: "touch" })).toBe(false);
    expect(isPalmContact({ pointerType: "touch", width: 1, height: 1 })).toBe(false);
    expect(isPalmContact({ pointerType: "touch", width: NaN, height: NaN })).toBe(false);
    expect(isPalmContact({})).toBe(false);
  });
  it("the limit is configurable", () => {
    expect(isPalmContact({ pointerType: "touch", width: 50, height: 50 }, 40)).toBe(true);
  });
});

describe("stroke gesture", () => {
  it("one finger draws: start, points, end at the lift position", () => {
    const g = new StrokeGesture();
    expect(g.down(1, 10, 10)).toEqual([{ type: "start", x: 10, y: 10 }]);
    expect(g.drawing).toBe(true);
    expect(g.claims(1)).toBe(true);
    expect(g.move(1, 20, 25)).toEqual([{ type: "point", x: 20, y: 25 }]);
    expect(g.up(1)).toEqual([{ type: "end", x: 20, y: 25 }]);
    expect(g.drawing).toBe(false);
  });
  it("a tap ends where it started (a dot)", () => {
    const g = new StrokeGesture();
    g.down(1, 5, 6);
    expect(g.up(1)).toEqual([{ type: "end", x: 5, y: 6 }]);
  });
  it("a second finger cancels the stroke and hands the gesture to pan/zoom", () => {
    const g = new StrokeGesture();
    g.down(1, 0, 0);
    g.move(1, 5, 5);
    expect(g.down(2, 50, 50)).toEqual([{ type: "cancel" }]);
    expect(g.drawing).toBe(false);
    expect(g.move(1, 9, 9)).toEqual([]);
    expect(g.up(2)).toEqual([]);
    expect(g.up(1)).toEqual([]); // nothing committed, ever
  });
  it("a gesture that began as a pinch never draws, even when it ends on one finger", () => {
    const g = new StrokeGesture();
    g.down(1, 0, 0);
    g.down(2, 50, 50);
    g.up(1);
    expect(g.move(2, 60, 60)).toEqual([]);
    expect(g.up(2)).toEqual([]);
    // and the next touch draws again
    expect(g.down(3, 1, 1)).toEqual([{ type: "start", x: 1, y: 1 }]);
  });
  it("a cancelled pointer drops the stroke", () => {
    const g = new StrokeGesture();
    g.down(1, 0, 0);
    g.move(1, 4, 4);
    expect(g.up(1, true)).toEqual([{ type: "cancel" }]);
  });
  it("ignores unknown pointers", () => {
    const g = new StrokeGesture();
    expect(g.move(9, 1, 1)).toEqual([]);
    expect(g.up(9)).toEqual([]);
  });
});
