import { describe, expect, it } from "vitest";
import { TapGate } from "./tapGate";

describe("TapGate (raycast only)", () => {
  it("selects what the raycast hit and clears on empty space", () => {
    const g = new TapGate();
    expect(g.settle(g.begin(), true)).toBe("select");
    expect(g.settle(g.begin(), false)).toBe("clear");
  });
  it("drops the result of a tap that a newer tap superseded", () => {
    const g = new TapGate();
    const old = g.begin();
    const next = g.begin();
    expect(g.settle(old, true)).toBe("stale");
    expect(g.settle(next, true)).toBe("select");
  });
});

describe("TapGate.invalidate (measure mode)", () => {
  it("makes a tap that is still in flight stale", () => {
    const g = new TapGate();
    const t = g.begin();
    g.invalidate();
    expect(g.settle(t, true)).toBe("stale");
    expect(g.settle(t, false)).toBe("stale");
  });
});
