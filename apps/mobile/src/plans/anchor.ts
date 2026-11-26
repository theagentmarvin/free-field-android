/**
 * Plan anchor: the position a "New task here" long-press hands to the task
 * form via `/tasks/new?anchor=...`. Format (all parts URL-safe):
 *
 *   plan~<pdfFileId>~<planVersionId>~<page>~<u>~<v>
 *
 * u/v are normalized 0..1 over the page (origin top-left, y down).
 */
export interface PlanAnchor {
  pdfFileId: string;
  planVersionId: string;
  page: number;
  uv: [number, number];
}

const ID = /^[A-Za-z0-9_-]+$/;

export function encodeAnchor(a: PlanAnchor): string {
  const u = clamp01(a.uv[0]).toFixed(5);
  const v = clamp01(a.uv[1]).toFixed(5);
  return `plan~${a.pdfFileId}~${a.planVersionId}~${a.page}~${u}~${v}`;
}

export function parseAnchor(s: string | null | undefined): PlanAnchor | null {
  if (!s) return null;
  const parts = s.split("~");
  if (parts.length !== 6 || parts[0] !== "plan") return null;
  const [, pdfFileId, planVersionId, pageS, uS, vS] = parts;
  const page = Number(pageS);
  const u = Number(uS);
  const v = Number(vS);
  if (!ID.test(pdfFileId) || !ID.test(planVersionId)) return null;
  if (!Number.isInteger(page) || page < 1) return null;
  if (!Number.isFinite(u) || !Number.isFinite(v) || u < 0 || u > 1 || v < 0 || v > 1) return null;
  return { pdfFileId, planVersionId, page, uv: [u, v] };
}

export const newTaskUrl = (a: PlanAnchor) => `/tasks/new?anchor=${encodeURIComponent(encodeAnchor(a))}`;

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);
