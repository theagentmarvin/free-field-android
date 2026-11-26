import { describe, expect, it } from "vitest";
import { EditorGesture } from "./viewGesture";

describe("EditorGesture", () => {
  it("one finger draws: start, moves, end", () => {
    const g = new EditorGesture();
    expect(g.down(1, 10, 10)).toEqual([{ type: "draw-start", x: 10, y: 10 }]);
    expect(g.drawing).toBe(true);
    expect(g.move(1, 20, 15)).toEqual([{ type: "draw-move", x: 20, y: 15 }]);
    expect(g.up(1)).toEqual([{ type: "draw-end", x: 20, y: 15 }]);
    expect(g.drawing).toBe(false);
    expect(g.pointerCount).toBe(0);
  });
  it("a second finger cancels the stroke and hands over to pan and zoom", () => {
    const g = new EditorGesture();
    g.down(1, 100, 100);
    g.move(1, 110, 110);
    expect(g.down(2, 200, 100)).toEqual([{ type: "draw-cancel" }]);
    expect(g.drawing).toBe(false);
    expect(g.navigating).toBe(true);
    // pinch out: distance 100 -> 200 about the midpoint
    const r = g.move(2, 310, 110);
    expect(r).toHaveLength(1);
    const ev = r[0];
    if (ev.type !== "nav") throw new Error("expected nav");
    expect(ev.scale).toBeCloseTo(200 / Math.hypot(90, 10), 3); // from (110,110)-(200,100) to (110,110)-(310,110)
    expect(g.up(1)).toEqual([]);
    expect(g.up(2)).toEqual([]);
  });
  it("two fingers moving together pan without zooming", () => {
    const g = new EditorGesture();
    g.down(1, 100, 100);
    g.down(2, 200, 100);
    const a = g.move(1, 110, 120)[0];
    const b = g.move(2, 210, 120)[0];
    if (a.type !== "nav" || b.type !== "nav") throw new Error("expected nav");
    expect(a.dx + b.dx).toBeCloseTo(10);
    expect(a.dy + b.dy).toBeCloseTo(20);
    expect(a.scale * b.scale).toBeCloseTo(1, 1);
  });
  it("a gesture that began as a pinch never draws, even on one finger after", () => {
    const g = new EditorGesture();
    g.down(1, 0, 0);
    g.down(2, 50, 0);
    g.up(2);
    expect(g.move(1, 5, 5)[0]).toMatchObject({ type: "nav", scale: 1 });
    expect(g.drawing).toBe(false);
    g.up(1);
    expect(g.navigating).toBe(false);
    // the next touch draws again
    expect(g.down(3, 1, 1)).toEqual([{ type: "draw-start", x: 1, y: 1 }]);
  });
  it("a cancelled pointer drops the stroke", () => {
    const g = new EditorGesture();
    g.down(1, 5, 5);
    g.move(1, 6, 6);
    expect(g.up(1, true)).toEqual([{ type: "draw-cancel" }]);
  });
  it("ignores moves of unknown pointers and reset clears everything", () => {
    const g = new EditorGesture();
    expect(g.move(9, 1, 1)).toEqual([]);
    expect(g.up(9)).toEqual([]);
    g.down(1, 1, 1);
    g.reset();
    expect(g.pointerCount).toBe(0);
    expect(g.drawing).toBe(false);
  });
});
