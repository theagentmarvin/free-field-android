import { distance, formatArea, formatLength, polygonArea, polylineLength, type PageScale, type Point } from "./webMath";

export type PlanMeasureKind = "length" | "area" | "angle";

/** One stored plan measurement. Points are in page units (PDF points, rotation applied), the web's convention. */
export interface PlanMeasurement {
  id: string;
  kind: PlanMeasureKind;
  points: readonly Point[];
}

/** Points a finished measurement needs. */
export const MIN_POINTS: Record<PlanMeasureKind, number> = { length: 2, area: 3, angle: 3 };

/** Angle tools finish themselves on the third point. */
export const AUTO_FINISH_POINTS: Partial<Record<PlanMeasureKind, number>> = { angle: 3 };

/** Interior angle at `vertex` between the rays to `a` and `b`, in degrees (0..180). 0 for a degenerate ray. */
export function angleDeg(a: Point, vertex: Point, b: Point): number {
  const ux = a.x - vertex.x;
  const uy = a.y - vertex.y;
  const vx = b.x - vertex.x;
  const vy = b.y - vertex.y;
  const nu = Math.hypot(ux, uy);
  const nv = Math.hypot(vx, vy);
  if (nu === 0 || nv === 0) return 0;
  const c = Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (nu * nv)));
  return (Math.acos(c) * 180) / Math.PI;
}

export function formatAngle(deg: number): string {
  const t = deg.toFixed(1);
  return `${/^-0(\.0+)?$/.test(t) ? t.slice(1) : t}°`;
}

/** Normalized page position (uv, 0..1) to page units. */
export function uvToPage(uv: readonly [number, number], page: { width: number; height: number }): Point {
  return { x: uv[0] * page.width, y: uv[1] * page.height };
}

/** Real distance in metres between two uv positions through a metres-per-page-unit scale; null when uncalibrated. */
export function uvDistanceMetres(a: readonly [number, number], b: readonly [number, number], page: { width: number; height: number }, scale: PageScale): number | null {
  if (scale.metresPerUnit === null) return null;
  return distance(uvToPage(a, page), uvToPage(b, page)) * scale.metresPerUnit;
}

/** Raw value in page units (length, area) or degrees (angle). */
export function measurementValue(m: Pick<PlanMeasurement, "kind" | "points">): number {
  switch (m.kind) {
    case "length":
      return polylineLength(m.points);
    case "area":
      return polygonArea(m.points);
    case "angle":
      return m.points.length >= 3 ? angleDeg(m.points[0], m.points[1], m.points[2]) : 0;
  }
}

/** Display text, the web's formatting (metres once scaled, page points before). */
export function formatMeasurement(m: Pick<PlanMeasurement, "kind" | "points">, scale: PageScale): string {
  const v = measurementValue(m);
  switch (m.kind) {
    case "length":
      return formatLength(v, scale);
    case "area":
      return formatArea(v, scale);
    case "angle":
      return formatAngle(v);
  }
}

export const KIND_LABEL: Record<PlanMeasureKind, string> = { length: "Length", area: "Area", angle: "Angle" };

/** Parse a typed length ("12,5", " 3.2 "): positive and finite, or null. */
export function parseLength(text: string): number | null {
  const n = Number(text.trim().replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : null;
}
