import { useSyncExternalStore } from "react";

export type PersistResult = "granted" | "denied" | "unsupported" | "pending";

let state: PersistResult = "pending";
const listeners = new Set<() => void>();

function set(next: PersistResult): void {
  state = next;
  listeners.forEach((l) => l());
}

/**
 * Ask the WebView to keep our storage from being evicted (SPEC A3). Safe to call
 * repeatedly; the result is exposed to the More screen via {@link usePersistResult}.
 */
export async function requestPersistence(storage: Pick<StorageManager, "persist" | "persisted"> | undefined = typeof navigator === "undefined" ? undefined : navigator.storage): Promise<PersistResult> {
  if (!storage?.persist) {
    set("unsupported");
    return state;
  }
  try {
    const already = (await storage.persisted?.()) ?? false;
    set(already || (await storage.persist()) ? "granted" : "denied");
  } catch {
    set("denied");
  }
  return state;
}

export function usePersistResult(): PersistResult {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
    () => state,
  );
}

/** Test hook. */
export function __resetPersistForTest(): void {
  state = "pending";
}
