import { Network, type ConnectionStatus } from "@capacitor/network";
import { useSyncExternalStore } from "react";

/**
 * Single source of truth for connectivity. `navigator.onLine` is unreliable in
 * an Android WebView, so we use @capacitor/network and mirror every change as
 * window `online`/`offline` events (the @ff/tasks outbox listens to those).
 */
export interface NetworkSnapshot {
  online: boolean;
  connectionType: ConnectionStatus["connectionType"] | "unknown";
}

let snapshot: NetworkSnapshot = {
  online: typeof navigator === "undefined" ? true : navigator.onLine,
  connectionType: "unknown",
};
const listeners = new Set<() => void>();
let started = false;

function apply(status: ConnectionStatus): void {
  const changed = status.connected !== snapshot.online || status.connectionType !== snapshot.connectionType;
  const wasOnline = snapshot.online;
  snapshot = { online: status.connected, connectionType: status.connectionType };
  mirrorNavigatorOnLine(status.connected);
  if (!changed) return;
  if (wasOnline !== status.connected) {
    window.dispatchEvent(new Event(status.connected ? "online" : "offline"));
  }
  listeners.forEach((l) => l());
}

/**
 * The shared task outbox decides "am I online?" from `navigator.onLine`, which
 * the WebView is slow (or wrong) to update. Make it follow @capacitor/network.
 */
function mirrorNavigatorOnLine(online: boolean): void {
  try {
    Object.defineProperty(navigator, "onLine", { configurable: true, get: () => online });
  } catch {
    /* read-only navigator: the engine falls back to the WebView's own flag */
  }
}

/** Re-read the OS connectivity (used on app resume, when events may have been missed). */
export async function refreshNetwork(): Promise<void> {
  try {
    apply(await Network.getStatus());
  } catch {
    /* plugin unavailable (plain browser) */
  }
}

/** Current connectivity (non-reactive). */
export function getNetworkSnapshot(): NetworkSnapshot {
  return snapshot;
}

/** Notified when connectivity flips (not on connection-type changes). Returns an unsubscribe. */
export function onOnlineChange(cb: (online: boolean) => void): () => void {
  let last = snapshot.online;
  const listener = () => {
    if (snapshot.online !== last) {
      last = snapshot.online;
      cb(last);
    }
  };
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Notified on any change, including connection-type changes (Wi-Fi to cellular). Returns an unsubscribe. */
export function onNetworkChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Idempotent. Call once at startup. */
export function startNetworkMonitor(): void {
  if (started) return;
  started = true;
  void refreshNetwork();
  void Network.addListener("networkStatusChange", apply);
}

/** Test hook. */
export function __setNetworkForTest(status: ConnectionStatus): void {
  apply(status);
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};

export function useNetworkStatus(): NetworkSnapshot {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}
