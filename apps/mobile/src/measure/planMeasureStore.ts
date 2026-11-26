import { useSyncExternalStore } from "react";
import type { PlanMeasurement } from "./planMath";

/**
 * Plan measurements of one user: points in page units per plan version and page, plus the user's own metres-per-page-unit
 * scale per plan version and page ("Set scale from a known distance"). Same shape and key as the web Documents module
 * (`<pdfVersionId>#<page>`), which keeps them in memory only; the tablet persists them in localStorage, per user. Nothing
 * syncs: the data model has no slot for them (a calibration record needs world point pairs).
 */
export interface PlanMeasureData {
  measurements: Record<string, PlanMeasurement[]>;
  scales: Record<string, number>;
}

export const measureKey = (planVersionId: string, page = 1) => `${planVersionId}#${page}`;

const EMPTY: PlanMeasureData = { measurements: {}, scales: {} };
const storageKey = (uid: string) => `ffm.planMeasure.v1.${uid || "anon"}`;

function sanitize(raw: unknown): PlanMeasureData {
  const out: PlanMeasureData = { measurements: {}, scales: {} };
  if (!raw || typeof raw !== "object") return out;
  const r = raw as { measurements?: unknown; scales?: unknown };
  if (r.measurements && typeof r.measurements === "object") {
    for (const [k, list] of Object.entries(r.measurements as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue;
      const rows: PlanMeasurement[] = [];
      for (const m of list as Partial<PlanMeasurement>[]) {
        if (!m || typeof m.id !== "string" || !Array.isArray(m.points)) continue;
        if (m.kind !== "length" && m.kind !== "area" && m.kind !== "angle") continue;
        const pts = m.points.filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y)).map((p) => ({ x: p.x, y: p.y }));
        if (pts.length === m.points.length) rows.push({ id: m.id, kind: m.kind, points: pts });
      }
      if (rows.length) out.measurements[k] = rows;
    }
  }
  if (r.scales && typeof r.scales === "object") {
    for (const [k, v] of Object.entries(r.scales as Record<string, unknown>)) if (typeof v === "number" && Number.isFinite(v) && v > 0) out.scales[k] = v;
  }
  return out;
}

export class PlanMeasureStore {
  private data: PlanMeasureData = EMPTY;
  private listeners = new Set<() => void>();
  private seq = 0;

  constructor(
    private readonly uid: string,
    private readonly storage: Pick<Storage, "getItem" | "setItem"> | null = (() => {
      try {
        return globalThis.localStorage ?? null;
      } catch {
        return null;
      }
    })(),
  ) {
    try {
      const raw = this.storage?.getItem(storageKey(uid));
      if (raw) this.data = sanitize(JSON.parse(raw));
    } catch {
      /* corrupt or blocked storage: start empty */
    }
  }

  getSnapshot = (): PlanMeasureData => this.data;
  subscribe = (cb: () => void) => {
    this.listeners.add(cb);
    return () => void this.listeners.delete(cb);
  };

  private commit(next: PlanMeasureData) {
    this.data = next;
    try {
      this.storage?.setItem(storageKey(this.uid), JSON.stringify(next));
    } catch {
      /* storage full or blocked: keep it for the session */
    }
    for (const l of this.listeners) l();
  }

  list(key: string): PlanMeasurement[] {
    return this.data.measurements[key] ?? [];
  }

  add(key: string, m: Omit<PlanMeasurement, "id">): PlanMeasurement {
    const row = { ...m, id: `pm${Date.now().toString(36)}${++this.seq}` };
    this.commit({ ...this.data, measurements: { ...this.data.measurements, [key]: [...this.list(key), row] } });
    return row;
  }

  remove(key: string, id: string) {
    this.commit({ ...this.data, measurements: { ...this.data.measurements, [key]: this.list(key).filter((m) => m.id !== id) } });
  }

  clear(key: string) {
    this.commit({ ...this.data, measurements: { ...this.data.measurements, [key]: [] } });
  }

  setScale(key: string, metresPerUnit: number | null) {
    const scales = { ...this.data.scales };
    if (metresPerUnit && metresPerUnit > 0) scales[key] = metresPerUnit;
    else delete scales[key];
    this.commit({ ...this.data, scales });
  }
}

const stores = new Map<string, PlanMeasureStore>();
/** The store of a user (one instance per uid for the whole session). */
export function planMeasureStore(uid: string): PlanMeasureStore {
  let s = stores.get(uid);
  if (!s) stores.set(uid, (s = new PlanMeasureStore(uid)));
  return s;
}

export function usePlanMeasureData(store: PlanMeasureStore): PlanMeasureData {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
