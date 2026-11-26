/**
 * Element search: query parsing and result merging (pure, unit-tested). The engine does the scanning in its worker (name and
 * property queries, GUID lookup), so there is no JS-side copy of the model's properties; `searchEngine.ts` runs these plans.
 */
import { categoryLabel } from "./tree";

export type QueryKind = "empty" | "guid" | "id" | "text";

export interface ParsedQuery {
  raw: string;
  kind: QueryKind;
  /** trimmed text */
  text: string;
  /** a 22-character IFC GlobalId */
  guid: string | null;
  /** `#123` or a bare number: the element's local id */
  localId: number | null;
}

/** An IFC GlobalId: 22 characters of [0-9A-Za-z_$], with letters and digits (a plain word is not one). */
export function looksLikeGuid(s: string): boolean {
  return /^[0-9A-Za-z_$]{22}$/.test(s) && /[0-9]/.test(s) && /[A-Za-z]/.test(s);
}

export const MIN_TEXT = 2;

export function parseQuery(raw: string): ParsedQuery {
  const text = raw.trim();
  const base = { raw, text, guid: null, localId: null };
  if (!text) return { ...base, kind: "empty" };
  if (looksLikeGuid(text)) return { ...base, kind: "guid", guid: text };
  const id = /^#?(\d{1,9})$/.exec(text);
  if (id) return { ...base, kind: "id", localId: Number(id[1]) };
  return { ...base, kind: text.length < MIN_TEXT ? "empty" : "text" };
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Case-insensitive regex matching the text anywhere; runs of spaces match any whitespace. */
export function textRegex(text: string): RegExp {
  return new RegExp(escapeRegex(text.trim()).replace(/\s+/g, "\\s+"), "i");
}

export interface CategoryCount {
  name: string;
  count: number;
}

export interface CategoryMatch extends CategoryCount {
  label: string;
}

/**
 * Classes that match a type word: "wall" finds IFCWALL and IFCWALLSTANDARDCASE, "duct" the duct segments and fittings, "ifcslab"
 * the slabs. Label prefix beats label word beats raw name; at most `limit`, biggest first among equal scores.
 */
export function matchCategories(text: string, cats: readonly CategoryCount[], limit = 6): CategoryMatch[] {
  const q = text.trim().toLowerCase();
  if (q.length < MIN_TEXT) return [];
  const scored: Array<CategoryMatch & { score: number }> = [];
  for (const c of cats) {
    const label = categoryLabel(c.name);
    const l = label.toLowerCase();
    const raw = c.name.toLowerCase();
    let score = 0;
    if (l.startsWith(q)) score = 3;
    else if (l.split(/\s+/).some((w) => w.startsWith(q))) score = 2;
    else if (raw.includes(q.replace(/^ifc/, ""))) score = 1;
    if (score > 0) scored.push({ name: c.name, count: c.count, label, score });
  }
  return scored.sort((a, b) => b.score - a.score || b.count - a.count || a.label.localeCompare(b.label)).slice(0, limit).map((m) => ({ name: m.name, count: m.count, label: m.label }));
}

/** Merge per-class counts of several models (a class appears once with the summed count). */
export function mergeCategoryCounts(perModel: readonly (readonly CategoryCount[])[]): CategoryCount[] {
  const by = new Map<string, number>();
  for (const list of perModel) for (const c of list) by.set(c.name, (by.get(c.name) ?? 0) + c.count);
  return [...by.entries()].map(([name, count]) => ({ name, count }));
}

export type HitKind = "id" | "guid" | "name" | "property";
const ORDER: Record<HitKind, number> = { guid: 0, id: 1, name: 2, property: 3 };

export interface RawHit {
  modelId: string;
  localId: number;
  kind: HitKind;
}

export interface Merged {
  hits: RawHit[];
  total: number;
  truncated: boolean;
}

/**
 * One list from the per-kind result lists: GlobalId and id matches first, then name matches, then property matches; an element
 * found by several kinds appears once, under its best kind; at most `limit` rows, `total` counts them all.
 */
export function mergeHits(parts: readonly RawHit[], limit: number): Merged {
  const best = new Map<string, RawHit>();
  for (const h of parts) {
    const k = `${h.modelId}:${h.localId}`;
    const cur = best.get(k);
    if (!cur || ORDER[h.kind] < ORDER[cur.kind]) best.set(k, h);
  }
  const all = [...best.values()].sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || a.modelId.localeCompare(b.modelId) || a.localId - b.localId);
  return { hits: all.slice(0, limit), total: all.length, truncated: all.length > limit };
}
