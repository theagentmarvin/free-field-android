/**
 * Link view URLs. `/linkview/:buildingId` with
 *   plan    pdfFileId of the plan shown (else: the plan of `storey`, else the first calibrated plan)
 *   storey  calibrated storey name (a PDF can be calibrated on several)
 *   x, z    world point the walker starts at (metres); b: world bearing in degrees (atan2(dz, dx))
 * Build links with {@link linkviewPath}; parse with {@link parseLinkview}.
 */
export interface LinkviewParams {
  plan?: string | null;
  storey?: string | null;
  start?: { x: number; z: number; bearingDeg?: number } | null;
}

const ID = /^[A-Za-z0-9_-]+$/;
const num = (s: string | null): number | null => {
  if (s === null || s.trim() === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

export function linkviewPath(buildingId: string, p: LinkviewParams = {}): string {
  const q = new URLSearchParams();
  if (p.plan && ID.test(p.plan)) q.set("plan", p.plan);
  if (p.storey) q.set("storey", p.storey);
  if (p.start && Number.isFinite(p.start.x) && Number.isFinite(p.start.z)) {
    q.set("x", p.start.x.toFixed(3));
    q.set("z", p.start.z.toFixed(3));
    if (p.start.bearingDeg !== undefined && Number.isFinite(p.start.bearingDeg)) q.set("b", p.start.bearingDeg.toFixed(1));
  }
  const s = q.toString();
  return `/linkview/${encodeURIComponent(buildingId)}${s ? `?${s}` : ""}`;
}

export function parseLinkview(search: string | URLSearchParams): Required<Pick<LinkviewParams, "plan" | "storey">> & { start: { x: number; z: number; bearingDeg: number | null } | null } {
  const q = typeof search === "string" ? new URLSearchParams(search) : search;
  const plan = q.get("plan");
  const x = num(q.get("x"));
  const z = num(q.get("z"));
  return {
    plan: plan && ID.test(plan) ? plan : null,
    storey: q.get("storey") || null,
    start: x !== null && z !== null ? { x, z, bearingDeg: num(q.get("b")) } : null,
  };
}
