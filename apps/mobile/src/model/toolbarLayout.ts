/** Camera toolbar layout: a vertical rail on the right edge in landscape, a bottom bar in portrait. */
export type ToolbarLayout = "rail" | "bar";

export function toolbarLayout(stage: { w: number; h: number }): ToolbarLayout {
  return stage.w > stage.h ? "rail" : "bar";
}

export type ToolbarItem = "fit" | "reset" | "walk" | "measure" | "tools";

/** The groups, in order: view (Fit, Reset), modes (Walk, Measure: a segmented toggle), Tools. */
export const TOOLBAR_GROUPS: ReadonlyArray<{ id: "view" | "modes" | "tools"; items: readonly ToolbarItem[] }> = [
  { id: "view", items: ["fit", "reset"] },
  { id: "modes", items: ["walk", "measure"] },
  { id: "tools", items: ["tools"] },
];

export interface ToolbarState {
  ready: boolean;
  walking: boolean;
  measuring: boolean;
}

/** Which toolbar items are enabled and which toggle is on (one source of truth for the buttons and the tests). */
export function toolbarState(s: ToolbarState): Record<ToolbarItem, { enabled: boolean; on: boolean }> {
  return {
    fit: { enabled: s.ready && !s.walking, on: false },
    reset: { enabled: s.ready, on: false },
    walk: { enabled: s.ready && !s.measuring, on: s.walking },
    measure: { enabled: s.ready, on: s.measuring },
    tools: { enabled: s.ready && !s.walking && !s.measuring, on: false },
  };
}
