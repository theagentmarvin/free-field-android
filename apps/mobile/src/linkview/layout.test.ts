import { describe, expect, it } from "vitest";
import { clampRatio, DEFAULT_RATIO, MIN_PANE_PX, ratioFromDrag, splitDirection } from "./layout";

describe("split layout", () => {
  it("landscape is side by side, portrait stacked, square counts as stacked", () => {
    expect(splitDirection(1280, 720)).toBe("row");
    expect(splitDirection(800, 1280)).toBe("column");
    expect(splitDirection(600, 600)).toBe("column");
  });
  it("neither pane gets thinner than the minimum", () => {
    expect(clampRatio(0.02, 1000)).toBeCloseTo(MIN_PANE_PX / 1000);
    expect(clampRatio(0.99, 1000)).toBeCloseTo(1 - MIN_PANE_PX / 1000);
    expect(clampRatio(0.4, 1000)).toBe(0.4);
  });
  it("a container too small for two panes falls back to half and half; junk too", () => {
    expect(clampRatio(0.1, 200)).toBe(DEFAULT_RATIO);
    expect(clampRatio(NaN, 1000)).toBe(DEFAULT_RATIO);
  });
  it("a drag position maps to a ratio that leaves room for the divider", () => {
    expect(ratioFromDrag(500, 1024, 24)).toBeCloseTo(0.488, 3);
    expect(ratioFromDrag(0, 1000, 24)).toBeCloseTo(MIN_PANE_PX / 976);
    expect(ratioFromDrag(5000, 1000, 24)).toBeCloseTo(1 - MIN_PANE_PX / 976);
  });
});
