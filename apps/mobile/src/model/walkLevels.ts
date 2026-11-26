import { EYE_HEIGHT, type WalkState } from "./viewMath";

export interface WalkLevel {
  name: string;
  elevation: number;
}

/** The storeys the walker can stand on, lowest first (one per name; several model files repeat the same names). */
export function walkLevels(chips: ReadonlyArray<{ name: string; elevation: number }>): WalkLevel[] {
  return chips
    .filter((c) => Number.isFinite(c.elevation))
    .map((c) => ({ name: c.name, elevation: c.elevation }))
    .sort((a, b) => a.elevation - b.elevation || a.name.localeCompare(b.name));
}

/** Index of the level the walker stands on: the one whose elevation is nearest the floor. -1 without levels. */
export function levelIndexFor(levels: readonly WalkLevel[], floorY: number): number {
  let best = -1;
  let bestD = Infinity;
  levels.forEach((l, i) => {
    const d = Math.abs(l.elevation - floorY);
    if (d < bestD) {
      best = i;
      bestD = d;
    }
  });
  return best;
}

/** The level `delta` steps up (+1) or down (-1) from the current floor, or null at the end of the list. */
export function stepLevel(levels: readonly WalkLevel[], floorY: number, delta: number): WalkLevel | null {
  const i = levelIndexFor(levels, floorY);
  if (i < 0) return null;
  return levels[i + delta] ?? null;
}

/** Teleport to a level: the eye goes to the level's elevation + the eye height, x/z and heading stay. */
export function withLevel(state: WalkState, level: Pick<WalkLevel, "elevation">): WalkState {
  return { ...state, floorY: level.elevation };
}

export { EYE_HEIGHT };
