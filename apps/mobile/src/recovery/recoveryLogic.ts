/**
 * Decision logic for "the WebView renderer was killed" (Android lmkd under memory pressure, or a crash).
 * Native side (MainActivity / FfmWebViewClient) recreates the activity instead of letting the app die and
 * records the event; the fresh page asks `takeRendererGone()` and applies this decision.
 */

export const MEMORY_NOTICE = "Reloaded the 3D view after running out of memory";
export const CRASH_NOTICE = "Reloaded the app after the view stopped unexpectedly";
export const LOOP_NOTICE = "The 3D view keeps running out of memory. Open it again from the Model tab, with fewer models if it repeats";

/** A route that, reopened blindly after a renderer death, would load the heavy 3D scene again. */
export const isHeavyRoute = (route: string) => route === "/model" || route.startsWith("/model/");

export interface RendererGoneInfo {
  gone: boolean;
  /** `true` = renderer crashed, `false` = killed by the system (memory). */
  crashed: boolean;
  /** Deaths in the last window (including this one), counted natively. */
  recent: number;
}

export interface RecoveryDecision {
  /** Route to reopen (hash path, always starts with `/`), or null when nothing happened. */
  route: string | null;
  notice: string | null;
  /** True when the heavy route was swapped for a safe one to break a kill loop. */
  loopBroken: boolean;
}

/** Deaths within this window that count as a loop (after this many the 3D route is not reopened automatically). */
export const LOOP_DEATHS = 3;
export const LOOP_FALLBACK_ROUTE = "/plans";

export function sanitizeRoute(route: string | null | undefined): string {
  if (!route || !route.startsWith("/") || route.startsWith("//") || route.length > 512) return "/tasks";
  return route;
}

export function decideRecovery(info: RendererGoneInfo, lastRoute: string | null | undefined): RecoveryDecision {
  if (!info.gone) return { route: null, notice: null, loopBroken: false };
  const route = sanitizeRoute(lastRoute);
  if (isHeavyRoute(route) && info.recent >= LOOP_DEATHS) return { route: LOOP_FALLBACK_ROUTE, notice: LOOP_NOTICE, loopBroken: true };
  return { route, notice: info.crashed ? CRASH_NOTICE : MEMORY_NOTICE, loopBroken: false };
}

/** Android `onTrimMemory` levels (ComponentCallbacks2). */
export const TRIM = { RUNNING_MODERATE: 5, RUNNING_LOW: 10, RUNNING_CRITICAL: 15, UI_HIDDEN: 20, BACKGROUND: 40, MODERATE: 60, COMPLETE: 80 } as const;
export type PressureLevel = "none" | "low" | "critical";

/** What a trim level means for a foreground 3D view: `low` = shed cheap things, `critical` = shed everything evictable. */
export function pressureForTrim(level: number): PressureLevel {
  if (level >= TRIM.RUNNING_CRITICAL && level < TRIM.UI_HIDDEN) return "critical";
  if (level >= TRIM.RUNNING_LOW && level < TRIM.UI_HIDDEN) return "low";
  // background levels (>= 20) are the backgroundGuard's business: the view is not drawing
  return level >= TRIM.UI_HIDDEN ? "critical" : "none";
}

export interface HeapSample {
  usedMb: number;
  limitMb: number;
}

/** JS-side heuristic for devices that never send a trim callback: used heap vs the heap limit. */
export function pressureFromHeap(s: HeapSample | null, current: PressureLevel): PressureLevel {
  if (!s || s.limitMb <= 0) return current;
  const f = s.usedMb / s.limitMb;
  // hysteresis: enter at 0.7 / 0.85, leave below 0.6 / 0.75
  if (f >= 0.85 || (current === "critical" && f >= 0.75)) return "critical";
  if (f >= 0.7 || (current === "low" && f >= 0.6)) return "low";
  return "none";
}
