/**
 * Model tree: Model > spatial levels (Building > Storey > Space) > category groups > elements, built lazily from each model's
 * spatial structure (pure, unit-tested). Nothing below a node exists until the node is expanded: a model of 100k elements
 * costs a handful of node objects until the user opens a storey, and a group of thousands of elements shows 100 rows at a time.
 */

export interface SpatialItem {
  category: string | null;
  localId: number | null;
  children?: SpatialItem[];
}

/** The engine's raw spatial tree: category nodes (no id) alternate with id nodes (no category) below them. */
export interface RawSpatial {
  category: string | null;
  localId: number | null;
  children?: RawSpatial[];
}

/**
 * Turn the engine's alternating shape (`IFCSLAB#null > #79`, `#40 > IFCSLAB#null`) into one item per element that carries its own
 * class, with the element's parts / contents as children. The result hangs off a virtual root (no category, no id).
 */
export function normalizeSpatial(raw: RawSpatial): SpatialItem {
  const conv = (n: RawSpatial, cat: string | null): SpatialItem[] => {
    if (n.localId === null || n.localId === undefined) return (n.children ?? []).flatMap((g) => conv(g, n.category));
    const kids: SpatialItem[] = [];
    for (const c of n.children ?? []) {
      if (c.localId === null || c.localId === undefined) for (const g of c.children ?? []) kids.push(...conv(g, c.category));
      else kids.push(...conv(c, c.category));
    }
    return [{ category: cat, localId: n.localId, ...(kids.length ? { children: kids } : {}) }];
  };
  return { category: null, localId: null, children: conv(raw, raw.category) };
}

export type NodeKind = "model" | "spatial" | "group" | "element";

export interface TNode {
  /** stable key (path), unique in the tree */
  key: string;
  kind: NodeKind;
  modelId: string;
  /** shown until a real name is read from the model */
  fallback: string;
  category: string | null;
  /** the node's own element (spatial containers and elements); null for the model and the groups */
  localId: number | null;
  /** number of elements below (an element: 1) */
  count: number;
  /** lazily created children; null for a leaf */
  children: (() => TNode[]) | null;
  /** every localId at or below the node (cached after the first call) */
  ids: () => number[];
}

const SPATIAL = new Set(["IFCPROJECT", "IFCSITE", "IFCBUILDING", "IFCBUILDINGSTOREY", "IFCSPACE", "IFCFACILITY", "IFCFACILITYPART"]);
export const isSpatialCategory = (c: string | null): boolean => !!c && SPATIAL.has(c.toUpperCase());

const NAMES: Record<string, string> = {
  IFCWALL: "Walls",
  IFCWALLSTANDARDCASE: "Walls",
  IFCSLAB: "Slabs",
  IFCDOOR: "Doors",
  IFCWINDOW: "Windows",
  IFCCOLUMN: "Columns",
  IFCBEAM: "Beams",
  IFCMEMBER: "Members",
  IFCPLATE: "Plates",
  IFCROOF: "Roofs",
  IFCSTAIR: "Stairs",
  IFCSTAIRFLIGHT: "Stair flights",
  IFCRAMP: "Ramps",
  IFCRAMPFLIGHT: "Ramp flights",
  IFCRAILING: "Railings",
  IFCCOVERING: "Coverings",
  IFCCURTAINWALL: "Curtain walls",
  IFCFOOTING: "Footings",
  IFCPILE: "Piles",
  IFCFURNISHINGELEMENT: "Furnishing",
  IFCBUILDINGELEMENTPROXY: "Generic elements",
  IFCOPENINGELEMENT: "Openings",
  IFCSPACE: "Spaces",
  IFCDUCTSEGMENT: "Duct segments",
  IFCDUCTFITTING: "Duct fittings",
  IFCPIPESEGMENT: "Pipe segments",
  IFCPIPEFITTING: "Pipe fittings",
  IFCFLOWSEGMENT: "Flow segments",
  IFCFLOWFITTING: "Flow fittings",
  IFCFLOWTERMINAL: "Terminals",
  IFCFLOWCONTROLLER: "Flow controllers",
  IFCFLOWMOVINGDEVICE: "Pumps and fans",
  IFCFLOWSTORAGEDEVICE: "Tanks",
  IFCFLOWTREATMENTDEVICE: "Treatment devices",
  IFCDISTRIBUTIONELEMENT: "Distribution elements",
  IFCDISTRIBUTIONCONTROLELEMENT: "Controls",
  IFCDISTRIBUTIONFLOWELEMENT: "Flow elements",
  IFCENERGYCONVERSIONDEVICE: "Energy devices",
  IFCCABLECARRIERSEGMENT: "Cable carriers",
  IFCCABLESEGMENT: "Cables",
  IFCLIGHTFIXTURE: "Light fixtures",
  IFCSANITARYTERMINAL: "Sanitary terminals",
  IFCREINFORCINGBAR: "Reinforcing bars",
  IFCREINFORCINGMESH: "Reinforcing meshes",
  IFCTRANSPORTELEMENT: "Transport elements",
  IFCGEOGRAPHICELEMENT: "Site elements",
  IFCCIVILELEMENT: "Civil elements",
  IFCELEMENTASSEMBLY: "Assemblies",
  IFCBUILDINGSTOREY: "Storey",
  IFCBUILDING: "Building",
  IFCSITE: "Site",
  IFCPROJECT: "Project",
};

/** A readable name for an IFC class ("IFCDUCTSEGMENT" -> "Duct segments"); unknown classes lose the prefix and are title-cased. */
export function categoryLabel(category: string | null): string {
  if (!category) return "Other";
  const key = category.toUpperCase();
  const known = NAMES[key];
  if (known) return known;
  const bare = key.replace(/^IFC/, "").toLowerCase();
  return bare ? bare.charAt(0).toUpperCase() + bare.slice(1) : "Other";
}

/** Every localId at or below `item` (iterative: spatial trees of big models are deep and wide). */
export function collectIds(item: SpatialItem): number[] {
  const out: number[] = [];
  const stack: SpatialItem[] = [item];
  while (stack.length) {
    const it = stack.pop()!;
    if (it.localId !== null && it.localId !== undefined) out.push(it.localId);
    if (it.children) for (let i = it.children.length - 1; i >= 0; i--) stack.push(it.children[i]);
  }
  return out;
}

function countElements(item: SpatialItem): number {
  let n = 0;
  const stack: SpatialItem[] = [item];
  while (stack.length) {
    const it = stack.pop()!;
    if (it.localId !== null && it.localId !== undefined && !isSpatialCategory(it.category)) n++;
    if (it.children) for (const c of it.children) stack.push(c);
  }
  return n;
}

function memo<T>(f: () => T): () => T {
  let v: T | undefined;
  let done = false;
  return () => {
    if (!done) {
      v = f();
      done = true;
    }
    return v as T;
  };
}

function elementNode(modelId: string, parentKey: string, item: SpatialItem): TNode {
  const id = item.localId as number;
  const rest = (item.children ?? []).filter((c) => c.localId !== null);
  const key = `${parentKey}/e${id}`;
  const ids = memo(() => collectIds(item));
  return {
    key,
    kind: "element",
    modelId,
    fallback: `${categoryLabel(item.category)} ${id}`,
    category: item.category,
    localId: id,
    count: 1 + rest.reduce((n, c) => n + countElements(c), 0),
    // an element that carries parts (assembly) lists them as elements
    children: rest.length ? memo(() => rest.map((c) => elementNode(modelId, key, c))) : null,
    ids,
  };
}

/** The non-spatial children of a spatial node, grouped by class (largest group first), each group lazily listing its elements. */
function groupNodes(modelId: string, parentKey: string, items: SpatialItem[]): TNode[] {
  const by = new Map<string, SpatialItem[]>();
  for (const it of items) {
    const c = (it.category ?? "OTHER").toUpperCase();
    (by.get(c) ?? by.set(c, []).get(c)!).push(it);
  }
  const groups = [...by.entries()].sort((a, b) => b[1].length - a[1].length || categoryLabel(a[0]).localeCompare(categoryLabel(b[0])));
  return groups.map(([cat, list]) => {
    const key = `${parentKey}/g${cat}`;
    return {
      key,
      kind: "group" as const,
      modelId,
      fallback: categoryLabel(cat),
      category: cat,
      localId: null,
      count: list.reduce((n, it) => n + 1 + (it.children?.reduce((m, c) => m + countElements(c), 0) ?? 0), 0),
      children: memo(() => list.map((it) => elementNode(modelId, key, it))),
      ids: memo(() => list.flatMap((it) => collectIds(it))),
    };
  });
}

function spatialNode(modelId: string, parentKey: string, item: SpatialItem): TNode {
  const key = `${parentKey}/s${item.localId ?? item.category}`;
  const kids = item.children ?? [];
  const spatialKids = kids.filter((c) => isSpatialCategory(c.category));
  const elementKids = kids.filter((c) => !isSpatialCategory(c.category) && c.localId !== null);
  const label = item.category?.toUpperCase() === "IFCSPACE" ? "Space" : categoryLabel(item.category);
  return {
    key,
    kind: "spatial",
    modelId,
    fallback: item.localId !== null ? `${label} ${item.localId}` : label,
    category: item.category,
    localId: item.localId,
    count: countElements(item),
    children:
      spatialKids.length || elementKids.length
        ? memo(() => [...spatialKids.map((c) => spatialNode(modelId, key, c)), ...groupNodes(modelId, key, elementKids)])
        : null,
    ids: memo(() => collectIds(item)),
  };
}

/** The tree of one model: a model node whose children are the spatial structure (Project, Site and a lone Building are folded away). */
export function buildModelTree(modelId: string, label: string, root: SpatialItem): TNode {
  let top: SpatialItem = root;
  // Fold single-child chains (virtual root, Project, Site) so the first level the user sees is the Building.
  while (top.children && top.children.length === 1 && (top.localId === null || top.category === "IFCPROJECT" || top.category === "IFCSITE") && isSpatialCategory(top.children[0].category)) top = top.children[0];
  const key = `m${modelId}`;
  const kids = top === root ? (top.children ?? []) : [top];
  const spatialKids = kids.filter((c) => isSpatialCategory(c.category));
  const elementKids = kids.filter((c) => !isSpatialCategory(c.category) && c.localId !== null);
  return {
    key,
    kind: "model",
    modelId,
    fallback: label,
    category: null,
    localId: null,
    count: countElements(root),
    children: () => [...spatialKids.map((c) => spatialNode(modelId, key, c)), ...groupNodes(modelId, key, elementKids)],
    ids: memo(() => collectIds(root)),
  };
}

// ── flat rows for the list ──────────────────────────────────────────

export const PAGE = 100;

export type Row = { type: "node"; node: TNode; depth: number; expanded: boolean } | { type: "more"; parentKey: string; depth: number; remaining: number };

/**
 * The visible rows: expanded nodes list their children, at most `shown.get(key) ?? PAGE` of them with a "more" row after
 * (a group of 30k elements is never rendered whole). `children()` is only called for expanded nodes.
 */
export function flattenRows(roots: readonly TNode[], expanded: ReadonlySet<string>, shown: ReadonlyMap<string, number> = new Map()): Row[] {
  const rows: Row[] = [];
  const walk = (n: TNode, depth: number) => {
    const open = !!n.children && expanded.has(n.key);
    rows.push({ type: "node", node: n, depth, expanded: open });
    if (!open) return;
    const kids = n.children!();
    const limit = shown.get(n.key) ?? PAGE;
    for (const c of kids.slice(0, limit)) walk(c, depth + 1);
    if (kids.length > limit) rows.push({ type: "more", parentKey: n.key, depth: depth + 1, remaining: kids.length - limit });
  };
  for (const r of roots) walk(r, 0);
  return rows;
}

/** The localIds whose names the visible rows need (spatial nodes and elements, not groups or models). */
export function rowNameIds(rows: readonly Row[]): Map<string, number[]> {
  const by = new Map<string, number[]>();
  for (const r of rows) {
    if (r.type !== "node" || r.node.localId === null) continue;
    (by.get(r.node.modelId) ?? by.set(r.node.modelId, []).get(r.node.modelId)!).push(r.node.localId);
  }
  return by;
}
