/**
 * Link view layout mode: side by side ("split") or the plan drawn over the 3D view ("overlay", the web's "Overlap" mode),
 * with the plan's opacity. Pure + localStorage persistence, like `layout.ts`. The percent rules (integer 0..100, junk falls
 * back to the default) match the web's overlay opacity store.
 */
export type LinkMode = "split" | "overlay";
/** Which layer a touch goes to in overlay mode: the plan (place / turn the camera, pins) or the 3D view (look, walk, tools). */
export type OverlayTouch = "plan" | "3d";

export interface OverlayPrefs {
  mode: LinkMode;
  /** plan opacity, percent */
  opacity: number;
  touch: OverlayTouch;
}

/** Lower than the web's 85: here the 3D underneath is the first-person view the plan is read against. */
export const DEFAULT_OPACITY_PCT = 60;
export const DEFAULT_PREFS: OverlayPrefs = { mode: "split", opacity: DEFAULT_OPACITY_PCT, touch: "plan" };
const KEY = "ffm.linkview.overlay";

export function normalizeOpacityPct(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (v === null || v === undefined || (typeof v === "string" && v.trim() === "") || !Number.isFinite(n)) return DEFAULT_OPACITY_PCT;
  return Math.round(Math.min(100, Math.max(0, n)));
}

export function parsePrefs(raw: string | null): OverlayPrefs {
  if (!raw) return DEFAULT_PREFS;
  try {
    const o = JSON.parse(raw) as Partial<Record<keyof OverlayPrefs, unknown>>;
    return { mode: o.mode === "overlay" ? "overlay" : "split", opacity: normalizeOpacityPct(o.opacity), touch: o.touch === "3d" ? "3d" : "plan" };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function loadOverlayPrefs(): OverlayPrefs {
  try {
    return parsePrefs(window.localStorage.getItem(KEY));
  } catch {
    return DEFAULT_PREFS;
  }
}

export function saveOverlayPrefs(p: OverlayPrefs): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* storage blocked: the mode simply is not remembered */
  }
}

/** The CSS opacity (0..1) of the plan layer. */
export const planAlpha = (p: Pick<OverlayPrefs, "mode" | "opacity">): number => (p.mode === "overlay" ? p.opacity / 100 : 1);
