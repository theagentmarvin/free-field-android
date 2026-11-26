import { describe, expect, it } from "vitest";
import { AIM_OFFSET_PX, reticleFor, TouchIntent } from "./touchIntent";

describe("TouchIntent", () => {
  it("a tap (no movement) places at the finger", () => {
    const g = new TouchIntent();
    expect(g.down(1, 100, 200)).toEqual([]);
    expect(g.phase).toBe("pending");
    expect(g.swallowMoves).toBe(true);
    expect(g.up(1)).toEqual([{ type: "place", x: 100, y: 200 }]);
    expect(g.phase).toBe("idle");
  });

  it("jitter within the slop is still a tap", () => {
    const g = new TouchIntent({ slop: 10 });
    g.down(1, 100, 200);
    g.move(1, 104, 203);
    expect(g.phase).toBe("pending");
    expect(g.up(1)).toEqual([{ type: "place", x: 104, y: 203 }]);
  });

  it("a drag past the slop orbits, lets the camera see the moves and never places", () => {
    const g = new TouchIntent({ slop: 10 });
    g.down(1, 100, 200);
    expect(g.move(1, 130, 200)).toEqual([]);
    expect(g.phase).toBe("orbit");
    expect(g.swallowMoves).toBe(false);
    expect(g.holdArmed).toBe(false);
    expect(g.hold()).toEqual([]);
    expect(g.up(1)).toEqual([]);
    expect(g.phase).toBe("idle");
  });

  it("a long press aims with the reticle above the finger; sliding moves it; lifting places there", () => {
    const g = new TouchIntent();
    g.down(1, 300, 400);
    expect(g.hold()).toEqual([{ type: "aim", x: 300, y: 400 - AIM_OFFSET_PX, fx: 300, fy: 400 }]);
    expect(g.phase).toBe("aim");
    expect(g.swallowMoves).toBe(true);
    expect(g.move(1, 340, 420)).toEqual([{ type: "aim", x: 340, y: 420 - AIM_OFFSET_PX, fx: 340, fy: 420 }]);
    expect(g.up(1)).toEqual([{ type: "place", x: 340, y: 420 - AIM_OFFSET_PX }]);
  });

  it("a cancelled aim or tap places nothing", () => {
    const a = new TouchIntent();
    a.down(1, 1, 1);
    a.hold();
    expect(a.up(1, true)).toEqual([{ type: "cancel" }]);
    const b = new TouchIntent();
    b.down(1, 1, 1);
    expect(b.up(1, true)).toEqual([]);
  });

  it("a second finger hands everything to pan/zoom; a gesture that began as a pinch never places", () => {
    const g = new TouchIntent();
    g.down(1, 10, 10);
    g.hold();
    expect(g.down(2, 50, 50)).toEqual([{ type: "cancel" }]);
    expect(g.phase).toBe("multi");
    expect(g.swallowMoves).toBe(false);
    expect(g.up(2)).toEqual([]);
    expect(g.up(1)).toEqual([]);
    expect(g.phase).toBe("idle");
    // pending + second finger: no cancel needed, and the lift of the first finger is not a tap
    g.down(1, 10, 10);
    expect(g.down(2, 50, 50)).toEqual([]);
    expect(g.up(1)).toEqual([]);
    expect(g.up(2)).toEqual([]);
  });

  it("a new gesture can only start when every finger is up", () => {
    const g = new TouchIntent();
    g.down(1, 0, 0);
    g.down(2, 5, 5);
    g.up(1);
    g.down(3, 9, 9);
    expect(g.phase).toBe("multi");
    g.up(2);
    g.up(3);
    expect(g.phase).toBe("idle");
  });

  it("reticleFor keeps the ring inside the stage", () => {
    const rect = { left: 0, top: 100, right: 600, bottom: 900 };
    expect(reticleFor(300, 500, rect)).toEqual({ x: 300, y: 500 - AIM_OFFSET_PX });
    expect(reticleFor(300, 120, rect)).toEqual({ x: 300, y: 108 });
    expect(reticleFor(-20, 500, rect).x).toBe(8);
    expect(reticleFor(900, 500, rect).x).toBe(592);
  });
});
