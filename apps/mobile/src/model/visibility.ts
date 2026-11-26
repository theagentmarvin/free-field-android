/**
 * Visibility state machine for the Model tab (pure, unit-tested; the controller in `visibilityController.ts` applies it to
 * the engine). Layers, from coarse to fine:
 *
 *   model chips      hide a whole model (also parked out of the draw loop)
 *   categories       hide every element of an IFC class (walls, ducts, ...)
 *   hidden ids       "Hide selection", tree checkboxes
 *   isolate          show only these elements (Isolate selection)
 *   storey           show only the storey's elements (the storey chips)
 *   forced           elements the user explicitly turned back on: they beat the id-level layers and the categories
 *   solid (x-ray)    elements that stay opaque while everything else visible is drawn ghosted
 *
 * An element is hidden when its model is hidden, or when it is in no "forced" set and any other layer hides it.
 * The engine's raycast skips hidden items, so whatever this machine hides can never be picked.
 */

export type IdSets = ReadonlyMap<string, ReadonlySet<number>>;

export interface VisState {
  hiddenModels: ReadonlySet<string>;
  hiddenCategories: ReadonlySet<string>;
  hiddenIds: IdSets;
  forced: IdSets;
  isolated: IdSets | null;
  storey: IdSets | null;
  solid: IdSets | null;
}

export const INITIAL_VIS: VisState = {
  hiddenModels: new Set(),
  hiddenCategories: new Set(),
  hiddenIds: new Map(),
  forced: new Map(),
  isolated: null,
  storey: null,
  solid: null,
};

export type VisAction =
  | { t: "model"; modelId: string; visible: boolean }
  | { t: "category"; name: string; visible: boolean }
  | { t: "hide"; ids: IdSets }
  | { t: "show"; ids: IdSets }
  | { t: "isolate"; ids: IdSets }
  | { t: "storey"; keep: IdSets | null }
  | { t: "xray"; solid: IdSets | null }
  | { t: "clearIsolate" }
  | { t: "clearHidden" }
  | { t: "clearCategories" }
  | { t: "clearModels" }
  | { t: "allCategories"; names: readonly string[] }
  | { t: "showAll" };

function plusIds(a: IdSets, b: IdSets): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  for (const [m, s] of a) out.set(m, new Set(s));
  for (const [m, s] of b) {
    const t = out.get(m) ?? new Set<number>();
    for (const id of s) t.add(id);
    out.set(m, t);
  }
  return out;
}

function minusIds(a: IdSets, b: IdSets): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  for (const [m, s] of a) {
    const drop = b.get(m);
    const t = drop ? new Set([...s].filter((id) => !drop.has(id))) : new Set(s);
    if (t.size) out.set(m, t);
  }
  return out;
}

const toggled = <T>(set: ReadonlySet<T>, v: T, on: boolean): Set<T> => {
  const out = new Set(set);
  if (on) out.add(v);
  else out.delete(v);
  return out;
};

export function visReduce(s: VisState, a: VisAction): VisState {
  switch (a.t) {
    case "model":
      return { ...s, hiddenModels: toggled(s.hiddenModels, a.modelId, !a.visible) };
    case "category":
      return { ...s, hiddenCategories: toggled(s.hiddenCategories, a.name, !a.visible) };
    case "hide":
      return { ...s, hiddenIds: plusIds(s.hiddenIds, a.ids), forced: minusIds(s.forced, a.ids) };
    case "show":
      return { ...s, hiddenIds: minusIds(s.hiddenIds, a.ids), forced: plusIds(s.forced, a.ids) };
    case "isolate":
      // Isolate replaces the element-level choices: show exactly these (the model chips and the categories still apply).
      return { ...s, isolated: new Map([...a.ids].map(([m, ids]) => [m, new Set(ids)])), hiddenIds: new Map(), forced: new Map(), storey: null };
    case "storey":
      return { ...s, storey: a.keep ? new Map([...a.keep].map(([m, ids]) => [m, new Set(ids)])) : null, isolated: null, hiddenIds: new Map(), forced: new Map() };
    case "xray":
      return { ...s, solid: a.solid };
    case "clearIsolate":
      return { ...s, isolated: null };
    case "clearHidden":
      return { ...s, hiddenIds: new Map(), forced: new Map() };
    case "clearCategories":
      return { ...s, hiddenCategories: new Set() };
    case "clearModels":
      return { ...s, hiddenModels: new Set() };
    case "allCategories":
      return { ...s, hiddenCategories: new Set(a.names) };
    case "showAll":
      return INITIAL_VIS;
  }
}

/** What the machine knows of one model's elements. `all`: every element with geometry. */
export interface Universe {
  all: ReadonlySet<number> | readonly number[];
  /** category -> element ids (loaded lazily; only categories that are hidden need to be present) */
  categories: ReadonlyMap<string, ArrayLike<number>>;
}

export interface Hidden {
  /** every element of the model is hidden (model chip off) */
  all: boolean;
  ids: Set<number>;
}

/** The hidden elements of one model. */
export function computeHidden(s: VisState, modelId: string, u: Universe): Hidden {
  if (s.hiddenModels.has(modelId)) return { all: true, ids: new Set() };
  const hide = new Set<number>();
  for (const c of s.hiddenCategories) {
    const ids = u.categories.get(c);
    if (ids) for (let i = 0; i < ids.length; i++) hide.add(ids[i]);
  }
  const own = s.hiddenIds.get(modelId);
  if (own) for (const id of own) hide.add(id);
  const keepLayer = (keep: IdSets | null) => {
    if (!keep) return;
    const k = keep.get(modelId);
    for (const id of u.all) if (!k || !k.has(id)) hide.add(id);
  };
  keepLayer(s.isolated);
  keepLayer(s.storey);
  const forced = s.forced.get(modelId);
  if (forced) for (const id of forced) hide.delete(id);
  return { all: false, ids: hide };
}

export type ApplyOp = { op: "hideAll" } | { op: "showAll" } | { op: "hide"; ids: number[] } | { op: "show"; ids: number[] };

/** The engine calls that turn what is drawn for `prev` into `next` (`prev` undefined: everything is visible). */
export function planApply(prev: Hidden | undefined, next: Hidden): ApplyOp[] {
  const p: Hidden = prev ?? { all: false, ids: new Set() };
  if (next.all) return p.all ? [] : [{ op: "hideAll" }];
  const ops: ApplyOp[] = [];
  if (p.all) {
    ops.push({ op: "showAll" });
    if (next.ids.size) ops.push({ op: "hide", ids: [...next.ids] });
    return ops;
  }
  const hide = [...next.ids].filter((id) => !p.ids.has(id));
  const show = [...p.ids].filter((id) => !next.ids.has(id));
  if (show.length) ops.push({ op: "show", ids: show });
  if (hide.length) ops.push({ op: "hide", ids: hide });
  return ops;
}

/** Tri-state of a group of elements (tree node, category) under a computed hidden set. */
export function groupVisibility(h: Hidden, ids: ArrayLike<number>): "all" | "none" | "some" {
  if (h.all) return "none";
  let hidden = 0;
  for (let i = 0; i < ids.length; i++) if (h.ids.has(ids[i])) hidden++;
  return hidden === 0 ? "all" : hidden === ids.length ? "none" : "some";
}

/** Anything that is not the "everything visible, nothing ghosted" state (enables Show all). */
export function isFiltered(s: VisState): boolean {
  return s.hiddenModels.size > 0 || s.hiddenCategories.size > 0 || s.hiddenIds.size > 0 || s.isolated !== null || s.storey !== null || s.solid !== null || s.forced.size > 0;
}

/** Ids of one model as the one-model `IdSets` the actions take. */
export const idsOf = (modelId: string, ids: Iterable<number>): IdSets => new Map([[modelId, new Set(ids)]]);

/** Ghost plan of one model: null = nothing ghosted; otherwise every visible element except `solid` is ghosted. */
export function ghostSolid(s: VisState, modelId: string): ReadonlySet<number> | null {
  if (!s.solid) return null;
  return s.solid.get(modelId) ?? new Set();
}
