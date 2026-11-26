import { describe, expect, it } from "vitest";
import { TOOLBAR_GROUPS, toolbarLayout, toolbarState } from "./toolbarLayout";

describe("toolbar layout", () => {
  it("landscape gets the rail, portrait the bar", () => {
    expect(toolbarLayout({ w: 1280, h: 560 })).toBe("rail");
    expect(toolbarLayout({ w: 600, h: 800 })).toBe("bar");
    expect(toolbarLayout({ w: 700, h: 700 })).toBe("bar");
  });
  it("groups view, modes and tools in that order", () => {
    expect(TOOLBAR_GROUPS.map((g) => g.items.join("+"))).toEqual(["fit+reset", "walk+measure", "tools"]);
  });
  it("walk and measure exclude each other, tools wait for both", () => {
    const idle = toolbarState({ ready: true, walking: false, measuring: false });
    expect(idle.walk).toEqual({ enabled: true, on: false });
    const walking = toolbarState({ ready: true, walking: true, measuring: false });
    expect(walking.walk.on).toBe(true);
    expect(walking.fit.enabled).toBe(false);
    expect(walking.tools.enabled).toBe(false);
    const measuring = toolbarState({ ready: true, walking: false, measuring: true });
    expect(measuring.walk.enabled).toBe(false);
    expect(measuring.measure.on).toBe(true);
    expect(measuring.tools.enabled).toBe(false);
    expect(toolbarState({ ready: false, walking: false, measuring: false }).reset.enabled).toBe(false);
  });
});
