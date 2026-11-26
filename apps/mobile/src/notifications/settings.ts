import { useSyncExternalStore } from "react";

/**
 * Notification preferences. Local to the device (never synced) so they work offline and need no backend.
 * `master` is the global switch; the rest are per-category.
 */
export interface NotifySettings {
  master: boolean;
  assigned: boolean;
  status: boolean;
  /** comments and @mentions addressed to me */
  comments: boolean;
  deadlines: boolean;
}

export type NotifyCategory = Exclude<keyof NotifySettings, "master">;

export const DEFAULT_SETTINGS: NotifySettings = { master: true, assigned: true, status: true, comments: true, deadlines: true };

export const CATEGORY_LABELS: Record<NotifyCategory, { label: string; hint: string }> = {
  assigned: { label: "Assigned to me", hint: "A task is newly assigned to you" },
  status: { label: "Status changes", hint: "Tasks you created or are assigned to" },
  comments: { label: "Comments and mentions", hint: "Replies and @mentions addressed to you" },
  deadlines: { label: "Deadlines", hint: "Due today or overdue, once a day per task" },
};

const KEY = "ffm.notify.settings";

export interface KV {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export function localKV(): KV {
  return {
    get: (k) => {
      try {
        return window.localStorage.getItem(k);
      } catch {
        return null;
      }
    },
    set: (k, v) => {
      try {
        window.localStorage.setItem(k, v);
      } catch {
        /* storage full or blocked: preferences fall back to defaults */
      }
    },
    remove: (k) => {
      try {
        window.localStorage.removeItem(k);
      } catch {
        /* ignore */
      }
    },
  };
}

export function parseSettings(raw: string | null): NotifySettings {
  if (!raw) return DEFAULT_SETTINGS;
  try {
    const o = JSON.parse(raw) as Partial<Record<keyof NotifySettings, unknown>>;
    const pick = (k: keyof NotifySettings): boolean => (typeof o[k] === "boolean" ? (o[k] as boolean) : DEFAULT_SETTINGS[k]);
    return { master: pick("master"), assigned: pick("assigned"), status: pick("status"), comments: pick("comments"), deadlines: pick("deadlines") };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function readSettings(kv: KV = localKV()): NotifySettings {
  return parseSettings(kv.get(KEY));
}

const listeners = new Set<() => void>();
let cache: NotifySettings | null = null;

function current(): NotifySettings {
  return (cache ??= readSettings());
}

export function getSettings(): NotifySettings {
  return current();
}

export function updateSettings(patch: Partial<NotifySettings>, kv: KV = localKV()): NotifySettings {
  cache = { ...current(), ...patch };
  kv.set(KEY, JSON.stringify(cache));
  listeners.forEach((l) => l());
  return cache;
}

export function subscribeSettings(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useNotifySettings(): NotifySettings {
  return useSyncExternalStore(subscribeSettings, current, current);
}

/** Test-only: drop the in-memory copy. */
export function resetSettingsCache(): void {
  cache = null;
}
