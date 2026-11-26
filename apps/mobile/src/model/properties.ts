import { getPropertyGroups } from "@ff/viewer-react";

export interface PropertyGroupView {
  name: string;
  rows: [string, string][];
}

export interface ElementProps {
  title: string;
  category: string | null;
  guid: string | null;
  attributes: [string, string][];
  psets: PropertyGroupView[];
}

const HIDDEN_ATTRS = new Set(["_category", "_IfcClass", "_localId", "_guid"]);

/**
 * Turn the flat record the viewer returns (`Name`, `GlobalId`, ... plus `PsetName.Prop` entries) into
 * sections for the sheet. Uses the viewer's real pset grouping when present (a dot in a pset or
 * property name makes first-dot splitting ambiguous); otherwise splits at the first dot.
 */
export function toElementProps(data: Record<string, string>, fallbackTitle: string): ElementProps {
  const groups = getPropertyGroups(data);
  const psetKeys = new Set<string>();
  const psets: PropertyGroupView[] = [];
  if (groups) {
    for (const g of groups) {
      psets.push({ name: g.pset, rows: g.properties });
      for (const [p] of g.properties) psetKeys.add(`${g.pset}.${p}`);
    }
  }
  const attributes: [string, string][] = [];
  for (const [k, v] of Object.entries(data)) {
    if (HIDDEN_ATTRS.has(k) || psetKeys.has(k)) continue;
    if (!groups && k.includes(".")) {
      const i = k.indexOf(".");
      const name = k.slice(0, i);
      let g = psets.find((p) => p.name === name);
      if (!g) psets.push((g = { name, rows: [] }));
      g.rows.push([k.slice(i + 1), v]);
      continue;
    }
    if (v !== "") attributes.push([k, v]);
  }
  return {
    title: data["Name"] || data["Tag"] || fallbackTitle,
    category: data["_category"] || data["_IfcClass"] || null,
    guid: data["GlobalId"] || null,
    attributes,
    psets,
  };
}

export type PropsState =
  | { status: "loading" }
  | { status: "error"; reason: "none" | "failed" | "timeout" }
  | { status: "ready"; props: ElementProps };

export const PROPS_TIMEOUT_MS = 45_000;

/**
 * Fetch and shape an element's properties so the sheet always ends in `ready` or a readable `error`: a fetch that
 * rejects, resolves to nothing, or never resolves (a busy worker on a very large model) must never leave the sheet
 * spinning forever.
 */
export async function resolveProps(
  fetch: () => Promise<{ attributes: Record<string, string>; globalId?: string | null } | null | undefined>,
  fallbackTitle: string,
  timeoutMs = PROPS_TIMEOUT_MS,
): Promise<PropsState> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((res) => {
    timer = setTimeout(() => res("timeout"), timeoutMs);
  });
  try {
    const data = await Promise.race([fetch(), timeout]);
    if (data === "timeout") return { status: "error", reason: "timeout" };
    if (!data) return { status: "error", reason: "none" };
    const props = toElementProps(data.attributes, fallbackTitle);
    props.guid ??= data.globalId ?? null;
    return { status: "ready", props };
  } catch {
    return { status: "error", reason: "failed" };
  } finally {
    clearTimeout(timer);
  }
}
