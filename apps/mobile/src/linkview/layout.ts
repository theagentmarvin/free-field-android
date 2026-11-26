/** Split layout of the Link view: orientation, divider position, swapped panes. Pure, so it is unit tested. */
export type SplitDirection = "row" | "column";

/** Landscape container: plan and 3D side by side; portrait: stacked (plan on top). */
export const splitDirection = (w: number, h: number): SplitDirection => (w > h ? "row" : "column");

export const MIN_PANE_PX = 160;
export const DEFAULT_RATIO = 0.5;

/** Share (0..1) of the first pane, clamped so neither pane gets thinner than MIN_PANE_PX (when the container allows it). */
export function clampRatio(ratio: number, total: number): number {
  if (!Number.isFinite(ratio)) return DEFAULT_RATIO;
  if (!(total > 2 * MIN_PANE_PX)) return DEFAULT_RATIO;
  const lo = MIN_PANE_PX / total;
  return Math.min(Math.max(ratio, lo), 1 - lo);
}

/** Ratio for a divider dragged to `pos` px along a container of `total` px (the divider is `divider` px thick). */
export function ratioFromDrag(pos: number, total: number, divider = 0): number {
  const avail = total - divider;
  return avail > 0 ? clampRatio((pos - divider / 2) / avail, avail) : DEFAULT_RATIO;
}

export interface LayoutPrefs {
  ratio: number;
  swapped: boolean;
}
const KEY = "ffm.linkview.layout";

export function loadLayoutPrefs(): LayoutPrefs {
  try {
    const raw = JSON.parse(window.localStorage.getItem(KEY) ?? "null") as Partial<LayoutPrefs> | null;
    return { ratio: typeof raw?.ratio === "number" && Number.isFinite(raw.ratio) ? Math.min(0.85, Math.max(0.15, raw.ratio)) : DEFAULT_RATIO, swapped: raw?.swapped === true };
  } catch {
    return { ratio: DEFAULT_RATIO, swapped: false };
  }
}
export function saveLayoutPrefs(p: LayoutPrefs): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* storage blocked: the layout simply is not remembered */
  }
}
