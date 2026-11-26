import { testHooksEnabled } from "../dev/flag";
import type { Engine } from "./engine";
import type { SampleModel } from "./useSampleModel";

/**
 * Test-only synthetic heavy federation (a "campus"): the demo building's models repeated N times, each copy its own model
 * id and shifted sideways so the copies are distinct geometry, not drawn on top of each other. Mobile only ever opens
 * `.frag`, and there is no bigger sample, so this stands in for a federation about N times the demo (~118 MB x N).
 *
 * Opt-in at run time, test builds only (`VITE_FFM_TEST_HOOKS`): localStorage `ffm.heavy` = `4` or JSON
 * `{"n":4,"dx":95,"dz":95}` (n buildings on a 2-wide grid; dx / dz are the grid spacing in metres). The shipping
 * build has no such branch (the flag is a build-time constant, so the whole module is dropped).
 */
export interface CampusSpec {
  n: number;
  dx: number;
  dz: number;
}

// About one building footprint (~85 m) plus a street: the copies form one dense site, so the middle of the view is geometry.
const DEFAULT_SPACING = 95;

export function campusSpec(): CampusSpec | null {
  if (!testHooksEnabled()) return null;
  try {
    const raw = localStorage.getItem("ffm.heavy");
    if (!raw) return null;
    const v = JSON.parse(raw) as number | Partial<CampusSpec>;
    const o = typeof v === "number" ? { n: v } : v;
    const n = Math.max(1, Math.min(8, Math.floor(o.n ?? 4)));
    return { n, dx: o.dx ?? DEFAULT_SPACING, dz: o.dz ?? DEFAULT_SPACING };
  } catch {
    return null;
  }
}

const COPY = /^heavy-(\d+)-/;
export const campusCopyIndex = (modelId: string): number => Number(COPY.exec(modelId)?.[1] ?? 0);

/** The demo models repeated `spec.n` times (copy 0 is the demo itself). Copies share the original's `.frag` bytes on disk. */
export function expandCampus(base: readonly SampleModel[], spec: CampusSpec): SampleModel[] {
  const out: SampleModel[] = [...base];
  for (let k = 1; k < spec.n; k++) {
    for (const m of base) out.push({ ...m, fileId: `heavy-${k}-${m.fileId}`, versionId: `heavy-${k}-${m.versionId}`, name: `${m.name} ${k + 1}` });
  }
  return out;
}

/** Offset of campus copy `k` on a 2-wide grid. */
export function campusOffset(k: number, spec: CampusSpec): [number, number, number] {
  return [(k % 2) * spec.dx, 0, Math.floor(k / 2) * spec.dz];
}

const placed = new WeakMap<object, string>();

/**
 * Shift the campus copies of every loaded model. Called from the loaded-models listener, which the viewer fires right
 * before its first tile pass, so a copy never streams tiles at the wrong place. Idempotent per model.
 */
export function placeCampus(engine: Engine | null, spec: CampusSpec | null): void {
  if (!engine || !spec) return;
  for (const [id, model] of engine.fragments.core.models.list) {
    const k = campusCopyIndex(id);
    const obj = (model as { object?: { position: { x: number; y: number; z: number }; updateMatrixWorld: (f?: boolean) => void } }).object;
    if (k === 0 || !obj || placed.get(obj) === id) continue;
    const [x, y, z] = campusOffset(k, spec);
    obj.position.x += x;
    obj.position.y += y;
    obj.position.z += z;
    obj.updateMatrixWorld(true);
    placed.set(obj, id);
  }
}
