import { SAVED_VIEWS, STATUS_LABELS, type Chip, type QuickFilters } from "@ff/tasks-react";

/** The "Filters" line of the report title page: the same words the web prints for the current view. */
export function filterNote(v: {
  chip: Chip;
  search: string;
  viewId: string | null;
  scope: string;
  buildingName?: string | null;
  quick: QuickFilters;
  columnFilterCount: number;
}): string {
  const bits: string[] = [];
  const view = SAVED_VIEWS.find((s) => s.id === v.viewId);
  if (view) bits.push(`View: ${view.label}`);
  bits.push(`Status: ${v.chip === "all" ? "All" : v.chip === "open" ? "Open" : v.chip === "closed" ? "Closed" : (STATUS_LABELS[v.chip as number] ?? String(v.chip))}`);
  if (v.search.trim()) bits.push(`Search: "${v.search.trim()}"`);
  if (v.quick.mine) bits.push("My tasks");
  if (v.quick.overdue) bits.push("Overdue");
  if (v.scope === "building" && v.buildingName) bits.push(`Building: ${v.buildingName}`);
  if (v.columnFilterCount > 0) bits.push(`${v.columnFilterCount} column filter${v.columnFilterCount === 1 ? "" : "s"}`);
  return bits.join(" - ");
}
