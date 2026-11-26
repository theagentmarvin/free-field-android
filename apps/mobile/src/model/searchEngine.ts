import type { FragmentsModel } from "@thatopen/fragments";
import type { ModelIndex } from "./modelIndex";
import { categoryLabel } from "./tree";
import { matchCategories, mergeCategoryCounts, mergeHits, textRegex, type CategoryMatch, type HitKind, type ParsedQuery, type RawHit } from "./search";

export const RESULT_LIMIT = 50;

export interface SearchRow {
  modelId: string;
  localId: number;
  kind: HitKind;
  title: string;
  /** class label, e.g. "Walls" */
  sub: string;
  category: string | null;
}

export interface SearchResults {
  query: string;
  rows: SearchRow[];
  total: number;
  truncated: boolean;
  /** classes matching a type word, with the number of elements (whole building) */
  categories: CategoryMatch[];
}

const NAME_ATTRS = /^(Name|Tag|ObjectType|Description|LongName)$/;
const VALUE_ATTR = /^NominalValue$/;

/**
 * Run a search on the engine. Name and property scans, GlobalId lookup and class counts all happen in the fragments worker;
 * only the matching ids come back (capped to the rows shown), so memory stays flat however big the models are.
 */
export async function runSearch(index: ModelIndex, models: () => ReadonlyMap<string, FragmentsModel>, q: ParsedQuery, isStale: () => boolean): Promise<SearchResults> {
  const empty: SearchResults = { query: q.raw, rows: [], total: 0, truncated: false, categories: [] };
  if (q.kind === "empty") return empty;
  const raw: RawHit[] = [];
  const counts: Array<Array<{ name: string; count: number }>> = [];
  for (const [modelId, model] of models()) {
    if (isStale()) return empty;
    const all = await index.all(modelId);
    if (q.kind === "guid" && q.guid) {
      const found = await model.getLocalIdsByGuids([q.guid]);
      for (const id of found) if (id !== null && all.has(id)) raw.push({ modelId, localId: id, kind: "guid" });
    } else if (q.kind === "id" && q.localId !== null) {
      if (all.has(q.localId)) raw.push({ modelId, localId: q.localId, kind: "id" });
      // a number also matches names and tags ("Beam 207709"), searched below
    }
    if (q.kind === "text" || q.kind === "id") {
      const rx = textRegex(q.text);
      const byName = await model.getItemsByQuery({ attributes: { aggregation: "inclusive", queries: [{ name: NAME_ATTRS, value: rx }] } });
      for (const id of byName) if (all.has(id)) raw.push({ modelId, localId: id, kind: "name" });
      if (q.text.length >= 3) {
        const byProp = await model.getItemsByQuery({ relation: { name: "IsDefinedBy", query: { relation: { name: "HasProperties", query: { attributes: { queries: [{ name: VALUE_ATTR, value: rx }] } } } } } });
        for (const id of byProp) if (all.has(id)) raw.push({ modelId, localId: id, kind: "property" });
      }
    }
    if (q.kind === "text") {
      const cats = await index.categories(modelId);
      counts.push([...cats].map(([name, ids]) => ({ name, count: ids.length })));
    }
  }
  if (isStale()) return empty;
  const merged = mergeHits(raw, RESULT_LIMIT);
  const categories = q.kind === "text" ? matchCategories(q.text, mergeCategoryCounts(counts)) : [];
  const rows = await describe(index, merged.hits);
  return { query: q.raw, rows, total: merged.total, truncated: merged.truncated, categories };
}

/** Titles and class labels of the rows: one name request per model, class from the compact category index. */
async function describe(index: ModelIndex, hits: readonly RawHit[]): Promise<SearchRow[]> {
  const byModel = new Map<string, number[]>();
  for (const h of hits) (byModel.get(h.modelId) ?? byModel.set(h.modelId, []).get(h.modelId)!).push(h.localId);
  const names = new Map<string, Map<number, string>>();
  const catOf = new Map<string, Map<number, string>>();
  for (const [modelId, ids] of byModel) {
    names.set(modelId, await index.names(modelId, ids));
    const want = new Set(ids);
    const found = new Map<number, string>();
    for (const [cat, list] of await index.categories(modelId)) {
      for (let i = 0; i < list.length && found.size < want.size; i++) if (want.has(list[i])) found.set(list[i], cat);
    }
    catOf.set(modelId, found);
  }
  return hits.map((h) => {
    const category = catOf.get(h.modelId)?.get(h.localId) ?? null;
    return { ...h, title: names.get(h.modelId)?.get(h.localId) ?? `Element ${h.localId}`, sub: categoryLabel(category), category };
  });
}
