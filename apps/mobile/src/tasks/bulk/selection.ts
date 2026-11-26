import { create } from "zustand";
import { rangeIds, toggleId } from "@ff/tasks-react";

/**
 * Multi-select state for the task list. Pure transitions (so they are unit-testable) plus a small store. Selection mode is on
 * from the first long-press or the Select button until Done; leaving the project or the list view drops rows that are no longer
 * visible (`prune`).
 */
export interface SelectionState {
  active: boolean;
  ids: ReadonlySet<string>;
  /** last toggled id, the anchor of a range selection */
  anchor: string | null;
}

export const EMPTY_SELECTION: SelectionState = { active: false, ids: new Set(), anchor: null };

export const enter = (s: SelectionState, id?: string): SelectionState =>
  id === undefined ? { ...s, active: true } : { active: true, ids: new Set([...s.ids, id]), anchor: id };

export const toggle = (s: SelectionState, id: string): SelectionState => ({ active: true, ids: toggleId(s.ids, id), anchor: id });

/** Select every visible id (replaces the selection). */
export const selectAll = (s: SelectionState, visible: readonly string[]): SelectionState => ({ active: true, ids: new Set(visible), anchor: s.anchor });

export const clearSelection = (s: SelectionState): SelectionState => ({ ...s, ids: new Set(), anchor: null });

export const exit = (): SelectionState => EMPTY_SELECTION;

/** Add the inclusive range between the anchor and `id`, in display order. */
export const selectRange = (s: SelectionState, order: readonly string[], id: string): SelectionState => {
  const next = new Set(s.ids);
  for (const x of rangeIds(order, s.anchor, id)) next.add(x);
  return { active: true, ids: next, anchor: id };
};

/** Keep only ids still in the list. Returns the same object when nothing changed. */
export const prune = (s: SelectionState, visible: readonly string[]): SelectionState => {
  if (s.ids.size === 0) return s;
  const live = new Set(visible);
  let changed = false;
  const next = new Set<string>();
  for (const id of s.ids) {
    if (live.has(id)) next.add(id);
    else changed = true;
  }
  return changed ? { ...s, ids: next } : s;
};

export const allSelected = (s: SelectionState, visible: readonly string[]): boolean => visible.length > 0 && visible.every((id) => s.ids.has(id));

interface Store extends SelectionState {
  enter(id?: string): void;
  toggle(id: string): void;
  selectAll(visible: readonly string[]): void;
  clear(): void;
  exit(): void;
  prune(visible: readonly string[]): void;
}

export const useSelection = create<Store>((set) => ({
  ...EMPTY_SELECTION,
  enter: (id) => set((s) => enter(s, id)),
  toggle: (id) => set((s) => toggle(s, id)),
  selectAll: (visible) => set((s) => selectAll(s, visible)),
  clear: () => set((s) => clearSelection(s)),
  exit: () => set(exit()),
  prune: (visible) => set((s) => prune(s, visible)),
}));
