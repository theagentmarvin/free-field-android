import { describe, expect, it } from "vitest";
import { PlacementGesture } from "./placement";

describe("placement gesture", () => {
  it("a tap aims then places at the release position", () => {
    const g = new PlacementGesture();
    expect(g.down(1, 10, 20)).toEqual([{ type: "aim", x: 10, y: 20 }]);
    expect(g.aiming).toBe(true);
    expect(g.up(1)).toEqual([{ type: "place", x: 10, y: 20 }]);
    expect(g.aiming).toBe(false);
  });
  it("dragging moves the aim and places where the finger lifted", () => {
    const g = new PlacementGesture();
    g.down(1, 0, 0);
    expect(g.move(1, 5, 5)).toEqual([{ type: "aim", x: 5, y: 5 }]);
    expect(g.move(1, 30, 40)).toEqual([{ type: "aim", x: 30, y: 40 }]);
    expect(g.up(1)).toEqual([{ type: "place", x: 30, y: 40 }]);
  });
  it("a second finger cancels the aim and hands over to pan/zoom", () => {
    const g = new PlacementGesture();
    g.down(1, 0, 0);
    expect(g.down(2, 50, 50)).toEqual([{ type: "cancel" }]);
    expect(g.panning).toBe(true);
    expect(g.move(1, 5, 5)).toEqual([]);
    expect(g.move(2, 55, 55)).toEqual([]);
  });
  it("never places after a pinch, even when it ends on one finger, and re-arms once all fingers are up", () => {
    const g = new PlacementGesture();
    g.down(1, 0, 0);
    g.down(2, 50, 50);
    expect(g.up(2)).toEqual([]);
    expect(g.move(1, 9, 9)).toEqual([]);
    expect(g.up(1)).toEqual([]);
    expect(g.panning).toBe(false);
    expect(g.down(3, 7, 8)).toEqual([{ type: "aim", x: 7, y: 8 }]);
    expect(g.up(3)).toEqual([{ type: "place", x: 7, y: 8 }]);
  });
  it("a second finger landing first (two-finger start) never aims", () => {
    const g = new PlacementGesture();
    expect(g.down(1, 0, 0)).toHaveLength(1);
    g.down(2, 1, 1);
    g.up(1);
    expect(g.down(3, 2, 2)).toEqual([]); // finger 2 is still down: still a pan gesture
    expect(g.up(3)).toEqual([]);
    expect(g.up(2)).toEqual([]);
  });
  it("a cancelled pointer (system gesture) cancels instead of placing", () => {
    const g = new PlacementGesture();
    g.down(1, 4, 4);
    expect(g.up(1, true)).toEqual([{ type: "cancel" }]);
  });
  it("ignores events of unknown pointers", () => {
    const g = new PlacementGesture();
    expect(g.move(9, 1, 1)).toEqual([]);
    expect(g.up(9)).toEqual([]);
  });
});
