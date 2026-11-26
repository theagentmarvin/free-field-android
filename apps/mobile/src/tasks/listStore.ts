import { create } from "zustand";
import {
  SAVED_VIEWS,
  isFilterEmpty,
  loadSavedViewId,
  persistSavedViewId,
  type ActiveFilters,
  type Chip,
  type ColumnFilter,
  type ColumnId,
  type QuickFilters,
  type ScopeMode,
  type SortKey,
} from "@ff/tasks-react";

/** The tablet-only "Title A-Z" sort rides the web's column sort; every other key is the web's `SortKey`. */
export type ListSort = SortKey | "title";

/**
 * List view state. It is the same state the web Tasks module keeps in `TasksApp` (status chip, search, sort, saved view, scope,
 * quick filters, per-column filters), outside the components so it survives the phone's list -> detail -> back navigation.
 */
interface ListState {
  chip: Chip;
  search: string;
  sort: ListSort;
  viewId: string | null;
  scope: ScopeMode;
  /** the building "This building" scopes to; null = the first building of the project */
  scopeBuildingId: string | null;
  quick: QuickFilters;
  columnFilters: ActiveFilters;
  /** the Drafts tab (local compose drafts are not tasks, so no filter applies) */
  showDrafts: boolean;
  setChip(c: Chip): void;
  setSearch(s: string): void;
  setSort(s: ListSort): void;
  applyView(id: string | null): void;
  setScopeBuilding(id: string | null): void;
  setQuick(q: QuickFilters): void;
  setColumnFilter(col: ColumnId, f: ColumnFilter | undefined): void;
  clearFilters(): void;
  setShowDrafts(on: boolean): void;
  reset(): void;
}

function presetPatch(id: string | null): Partial<ListState> {
  const preset = SAVED_VIEWS.find((v) => v.id === id);
  if (!preset) return { viewId: null };
  return { viewId: preset.id, chip: preset.apply.chip, sort: preset.apply.sort, scope: preset.apply.scope };
}

const FRESH = { chip: "all" as Chip, search: "", sort: "updated" as ListSort, viewId: null, scope: "all" as ScopeMode, quick: {}, columnFilters: {}, showDrafts: false };

export const useListStore = create<ListState>((set) => ({
  ...FRESH,
  scopeBuildingId: null,
  // a persisted saved view re-asserts its state on start, like the web
  ...presetPatch(loadSavedViewId()),
  setChip: (chip) => set({ chip, showDrafts: false }),
  setSearch: (search) => set({ search }),
  setSort: (sort) => set({ sort }),
  applyView: (id) =>
    set((s) => {
      const next = s.viewId === id ? null : id; // tapping the active view again turns it off
      persistSavedViewId(next);
      return next === null ? { viewId: null, showDrafts: false } : { ...presetPatch(next), showDrafts: false };
    }),
  setScopeBuilding: (scopeBuildingId) => set({ scopeBuildingId }),
  setQuick: (quick) => set({ quick }),
  setColumnFilter: (col, f) =>
    set((s) => {
      const next = { ...s.columnFilters };
      if (!f || isFilterEmpty(f)) delete next[col];
      else next[col] = f;
      return { columnFilters: next };
    }),
  clearFilters: () => set({ columnFilters: {}, quick: {} }),
  setShowDrafts: (showDrafts) => set({ showDrafts }),
  reset: () => {
    persistSavedViewId(null);
    set({ ...FRESH });
  },
}));
