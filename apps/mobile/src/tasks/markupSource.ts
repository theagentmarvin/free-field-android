/**
 * Where a task markup takes its picture from: the same two framings as the task's location quick-access, the PLAN at the
 * task's pin and the 3D view at the task's pose or world point. A task can have either, both (a Link view task), or none.
 */
export type MarkupSource = "plan" | "3d";

interface LocLike {
  pdf?: { pdfFileId?: unknown; page?: unknown; uv?: unknown } | null;
  bim?: { elements?: unknown; worldPoint?: unknown; cameraPose?: unknown } | null;
}

const isUv = (v: unknown): v is [number, number] => Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1);
const isVec3 = (v: unknown) => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number" && Number.isFinite(n));

export function availableSources(loc: LocLike | null | undefined): MarkupSource[] {
  const out: MarkupSource[] = [];
  const pdf = loc?.pdf;
  if (pdf && typeof pdf.pdfFileId === "string" && pdf.pdfFileId && isUv(pdf.uv)) out.push("plan");
  const bim = loc?.bim;
  if (bim && (isVec3(bim.worldPoint) || (Array.isArray(bim.elements) && bim.elements.length > 0))) out.push("3d");
  return out;
}

/** What the page does for a task: capture straight away, ask first, or explain that it needs a location. */
export type MarkupPlan = { kind: "direct"; source: MarkupSource } | { kind: "choose"; sources: MarkupSource[] } | { kind: "none" };

export function planMarkup(loc: LocLike | null | undefined, asked: string | null | undefined): MarkupPlan {
  const sources = availableSources(loc);
  if (sources.length === 0) return { kind: "none" };
  if (sources.length === 1) return { kind: "direct", source: sources[0] };
  if (asked === "plan" || asked === "3d") return sources.includes(asked) ? { kind: "direct", source: asked } : { kind: "choose", sources };
  return { kind: "choose", sources };
}
