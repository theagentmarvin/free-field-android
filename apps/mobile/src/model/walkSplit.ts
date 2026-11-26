import type { CalibratedPlan } from "../linkview/plans";
import { walkerChanged } from "../linkview/sync";
import type { LinkWalker } from "../linkview/binding";
import { levelIndexFor, type WalkLevel } from "./walkLevels";

/**
 * The plan shown beside the 3D view while walking: a calibrated plan of the level the walker stands on (the level picker's nearest level),
 * or null when that level has none (the walk then takes the whole screen). `prefer` picks among several plans of one level.
 */
export function planForWalkLevel(plans: readonly CalibratedPlan[], levels: readonly WalkLevel[], floorY: number, prefer?: string | null): CalibratedPlan | null {
  const i = levelIndexFor(levels, floorY);
  if (i < 0) return null;
  const here = plans.filter((p) => p.storeyName === levels[i].name);
  return here.find((p) => p.pdfFileId === prefer) ?? here[0] ?? null;
}

/** The walker as a tiny external store: the 3D side publishes every step, the plan side re-renders only on a visible change (no ModelView re-render per frame). */
export interface WalkerStore {
  get(): LinkWalker | null;
  set(w: LinkWalker | null): void;
  subscribe(fn: () => void): () => void;
}
export function createWalkerStore(): WalkerStore {
  let cur: LinkWalker | null = null;
  const subs = new Set<() => void>();
  return {
    get: () => cur,
    set(w) {
      if (w !== null && cur !== null && !walkerChanged(cur, w) && cur.floorY === w.floorY) return;
      cur = w;
      subs.forEach((f) => f());
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}
