import type { StoreyRecord } from "@ff/types";

export interface StoreyChip {
  name: string;
  elevation: number;
  /** per source model: ids contained in this storey according to the synced rows */
  byModel: Map<string, Set<number>>;
}

/** One chip per storey name (several model files of a building repeat the same names), lowest first. */
export function storeyChips(rows: readonly StoreyRecord[]): StoreyChip[] {
  const by = new Map<string, StoreyChip>();
  for (const r of rows) {
    let c = by.get(r.name);
    if (!c) by.set(r.name, (c = { name: r.name, elevation: r.elevation, byModel: new Map() }));
    c.elevation = Math.min(c.elevation, r.elevation);
    const set = c.byModel.get(r.sourceIfcFileId) ?? new Set<number>();
    for (const id of r.containedElementIds ?? []) set.add(id);
    c.byModel.set(r.sourceIfcFileId, set);
  }
  return [...by.values()].sort((a, b) => a.elevation - b.elevation || a.name.localeCompare(b.name));
}

export interface IsolationPlan {
  modelId: string;
  show: Set<number>;
  hide: Set<number>;
}

/**
 * Visibility changes that isolate one storey: per model, everything with geometry is hidden except the
 * storey's elements. `modelLevels` (from the model's own spatial tree, keyed by storey name) wins over
 * the synced `containedElementIds` because it also covers elements nested below the storey node.
 * Models that have no elements in the storey are hidden entirely.
 */
export function isolationPlan(
  chip: StoreyChip,
  allIds: ReadonlyMap<string, readonly number[]>,
  modelLevels: ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<number>> | null>,
): IsolationPlan[] {
  const out: IsolationPlan[] = [];
  for (const [modelId, ids] of allIds) {
    const own = modelLevels.get(modelId)?.get(chip.name);
    const keep = own && own.size > 0 ? own : (chip.byModel.get(modelId) ?? new Set<number>());
    const show = new Set<number>();
    const hide = new Set<number>();
    for (const id of ids) (keep.has(id) ? show : hide).add(id);
    out.push({ modelId, show, hide });
  }
  return out;
}
