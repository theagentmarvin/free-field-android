import type { FragmentsModel } from "@thatopen/fragments";
import type { Universe } from "./visibility";
import { normalizeSpatial, type RawSpatial, type SpatialItem } from "./tree";
import type { Box, Vec3 } from "./viewMath";

export type Models = () => ReadonlyMap<string, FragmentsModel>;

/** Ids per category in typed arrays (4 bytes per element: 100k elements cost 400 KB, not a JS object graph). */
export type CategoryIndex = Map<string, Uint32Array>;

/**
 * Lazy, engine-backed lookups the tools share (element ids, categories, names, boxes). Everything is fetched from the
 * fragments worker on first use and cached compactly; the spatial tree is NOT cached here (the tree panel owns it while it
 * is open, so closing the panel frees it). `dispose` drops every cache (viewer reload, model switch).
 */
export class ModelIndex {
  private geom = new Map<string, Promise<Set<number>>>();
  private cats = new Map<string, Promise<CategoryIndex>>();
  private disposed = false;

  constructor(private readonly models: Models) {}

  private model(id: string): FragmentsModel | undefined {
    return this.disposed ? undefined : this.models().get(id);
  }

  modelIds(): string[] {
    return this.disposed ? [] : [...this.models().keys()];
  }

  /** Every element with geometry. */
  all(modelId: string): Promise<Set<number>> {
    let p = this.geom.get(modelId);
    if (!p) {
      const m = this.model(modelId);
      p = m ? m.getItemsIdsWithGeometry().then((ids) => new Set(ids)) : Promise.resolve(new Set<number>());
      this.geom.set(modelId, p);
    }
    return p;
  }

  /** Geometry elements grouped by IFC class. */
  categories(modelId: string): Promise<CategoryIndex> {
    let p = this.cats.get(modelId);
    if (!p) {
      p = this.loadCategories(modelId);
      this.cats.set(modelId, p);
    }
    return p;
  }

  private async loadCategories(modelId: string): Promise<CategoryIndex> {
    const m = this.model(modelId);
    const out: CategoryIndex = new Map();
    if (!m) return out;
    const [ids, cats] = await Promise.all([m.getItemsIdsWithGeometry(), m.getItemsWithGeometryCategories()]);
    const lists = new Map<string, number[]>();
    if (ids.length === cats.length) {
      for (let i = 0; i < ids.length; i++) {
        const c = (cats[i] ?? "OTHER").toUpperCase();
        (lists.get(c) ?? lists.set(c, []).get(c)!).push(ids[i]);
      }
    } else {
      // The two lists do not line up: ask the worker per class instead.
      const geometry = await this.all(modelId);
      const byCat = await m.getItemsOfCategories([/.*/]);
      for (const [c, list] of Object.entries(byCat)) {
        const keep = list.filter((id) => geometry.has(id));
        if (keep.length) lists.set(c.toUpperCase(), keep);
      }
    }
    for (const [c, list] of lists) out.set(c, Uint32Array.from(list));
    return out;
  }

  /** What the visibility machine needs for one model. */
  async universe(modelId: string, withCategories: boolean): Promise<Universe> {
    const [all, categories] = await Promise.all([this.all(modelId), withCategories ? this.categories(modelId) : Promise.resolve(new Map<string, Uint32Array>())]);
    return { all, categories };
  }

  async spatial(modelId: string): Promise<SpatialItem | null> {
    const m = this.model(modelId);
    return m ? normalizeSpatial((await m.getSpatialStructure()) as RawSpatial) : null;
  }

  /** Display names (Name, else Tag, else ObjectType) of some elements, one worker round trip. */
  async names(modelId: string, ids: readonly number[]): Promise<Map<number, string>> {
    const out = new Map<number, string>();
    const m = this.model(modelId);
    if (!m || ids.length === 0) return out;
    const rows = await m.getItemsData([...ids], { attributesDefault: false, attributes: ["Name", "Tag", "ObjectType"], relationsDefault: { attributes: false, relations: false } });
    rows.forEach((row, i) => {
      const n = pickName(row as Record<string, unknown>);
      if (n) out.set(ids[i], n);
    });
    return out;
  }

  /** World box of some elements. */
  async box(modelId: string, ids: readonly number[]): Promise<Box | null> {
    const m = this.model(modelId);
    if (!m || ids.length === 0) return null;
    const b = await m.getMergedBox([...ids]);
    if (!b || b.isEmpty()) return null;
    const min: Vec3 = [b.min.x, b.min.y, b.min.z];
    const max: Vec3 = [b.max.x, b.max.y, b.max.z];
    return [...min, ...max].every(Number.isFinite) ? { min, max } : null;
  }

  dispose(): void {
    this.disposed = true;
    this.geom.clear();
    this.cats.clear();
  }
}

/** First non-empty of Name, Tag, ObjectType from an engine item row (`{ Name: { value } }`). */
export function pickName(row: Record<string, unknown>): string | null {
  for (const k of ["Name", "Tag", "ObjectType"]) {
    const a = row?.[k] as { value?: unknown } | string | undefined;
    const v = typeof a === "object" && a !== null ? a.value : a;
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number") return String(v);
  }
  return null;
}
