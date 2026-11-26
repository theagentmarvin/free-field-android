/**
 * The Filters button and its summary chips (pure, unit-tested): what is filtered right now, as a short list of removable items.
 * The same list drives the badge ("Filters · 2") and the chips under the toolbar (at most two plus "+n").
 */
export type FilterKind = "level" | "models" | "categories" | "isolate" | "xray" | "hidden";

export interface FilterView {
  /** selected storey name, null = all levels */
  level: string | null;
  cut: boolean;
  modelsTotal: number;
  modelsVisible: number;
  categoriesHidden: number;
  isolated: boolean;
  xray: boolean;
  /** elements hidden one by one (Hide selection, tree checkboxes) */
  elementsHidden: boolean;
}

export interface FilterItem {
  kind: FilterKind;
  label: string;
}

export function filterItems(v: FilterView): FilterItem[] {
  const out: FilterItem[] = [];
  if (v.level) out.push({ kind: "level", label: v.cut ? `${v.level} · cut` : v.level });
  if (v.modelsTotal > 1 && v.modelsVisible < v.modelsTotal) out.push({ kind: "models", label: `${v.modelsVisible} of ${v.modelsTotal} models` });
  if (v.categoriesHidden > 0) out.push({ kind: "categories", label: `${v.categoriesHidden} ${v.categoriesHidden === 1 ? "category" : "categories"} hidden` });
  if (v.isolated) out.push({ kind: "isolate", label: "Isolated" });
  if (v.elementsHidden) out.push({ kind: "hidden", label: "Elements hidden" });
  if (v.xray) out.push({ kind: "xray", label: "X-ray" });
  return out;
}

/** The first `max` items as chips and the number of the rest ("+n"). */
export function splitItems<T>(items: readonly T[], max = 2): { shown: T[]; more: number } {
  return { shown: items.slice(0, max), more: Math.max(0, items.length - max) };
}

/** "Filters" or "Filters · 2". */
export function filtersLabel(count: number): string {
  return count > 0 ? `Filters · ${count}` : "Filters";
}
