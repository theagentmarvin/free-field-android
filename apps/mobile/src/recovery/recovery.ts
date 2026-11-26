import { Capacitor } from "@capacitor/core";
import { FfmFiles } from "../storage/ffmFiles";
import { decideRecovery, pressureForTrim, pressureFromHeap, type PressureLevel } from "./recoveryLogic";

const ROUTE_KEY = "ffm.lastRoute";

/** Remember where the user is (hash path) so a renderer death can reopen it. localStorage survives the renderer. */
export function recordRoute(route: string): void {
  try {
    localStorage.setItem(ROUTE_KEY, route);
  } catch {
    /* storage blocked */
  }
}

function lastRoute(): string | null {
  try {
    return localStorage.getItem(ROUTE_KEY);
  } catch {
    return null;
  }
}

// ── notice (one string, observable) ─────────────────────────────────────
let notice: string | null = null;
const noticeSubs = new Set<() => void>();
export const getNotice = () => notice;
export const subscribeNotice = (cb: () => void) => (noticeSubs.add(cb), () => void noticeSubs.delete(cb));
export function setNotice(n: string | null): void {
  notice = n;
  noticeSubs.forEach((cb) => cb());
}

/**
 * Before the first render: did the native layer recreate us after the renderer died? Then put the hash back to
 * the last route and queue the notice. Never throws, never waits longer than `timeoutMs`.
 */
export async function bootRecovery(timeoutMs = 1500): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  try {
    const info = await Promise.race([FfmFiles.takeRendererGone(), new Promise<null>((r) => setTimeout(() => r(null), timeoutMs))]);
    if (!info) return;
    const d = decideRecovery(info, lastRoute());
    if (!d.route) return;
    window.location.hash = `#${d.route}`;
    setNotice(d.notice);
  } catch {
    /* plugin missing (older native build): nothing to recover */
  }
}

// ── memory pressure ─────────────────────────────────────────────────────
let lastNative = 0;
let pressure: PressureLevel = "none";
const pressureSubs = new Set<(p: PressureLevel) => void>();
export const getPressure = () => pressure;
export function subscribePressure(cb: (p: PressureLevel) => void): () => void {
  pressureSubs.add(cb);
  return () => void pressureSubs.delete(cb);
}
export function setPressure(p: PressureLevel): void {
  if (p === pressure) return;
  pressure = p;
  pressureSubs.forEach((cb) => cb(p));
}

/** Native onTrimMemory events plus a JS heap heuristic. Returns a stop function. */
export function startPressureMonitor(): () => void {
  const stops: Array<() => void> = [];
  if (Capacitor.isNativePlatform()) {
    let handle: { remove(): Promise<void> } | null = null;
    let stopped = false;
    void FfmFiles.addListener("trimMemory", (e) => {
      const p = pressureForTrim(e.level);
      // a trim event is a one-shot: apply it, and let the heap heuristic bring the level back down
      lastNative = Date.now();
      setPressure(p);
    }).then((h) => {
      if (stopped) void h.remove();
      else handle = h;
    }, () => undefined);
    stops.push(() => {
      stopped = true;
      void handle?.remove();
    });
  }
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
  if (mem) {
    const t = setInterval(() => {
      const next = pressureFromHeap({ usedMb: mem.usedJSHeapSize / 1048576, limitMb: mem.jsHeapSizeLimit / 1048576 }, pressure);
      // the heap heuristic can raise the level and lower one it raised; it never overrides a fresh native critical downwards within 20 s
      if (next !== pressure && !(pressure === "critical" && Date.now() - lastNative < 20_000)) setPressure(next);
    }, 5000);
    stops.push(() => clearInterval(t));
  }
  return () => stops.forEach((s) => s());
}
