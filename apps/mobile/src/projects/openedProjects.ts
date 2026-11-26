import type { KeyValueStore } from "../auth/emailLink";

/**
 * Projects this user has opened on this device (so their data is in the local
 * cache). A project never opened here cannot be entered while offline.
 */
const key = (uid: string) => `ffm-opened-projects:${uid}`;

export function readOpenedProjects(store: KeyValueStore, uid: string): string[] {
  try {
    const parsed: unknown = JSON.parse(store.getItem(key(uid)) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function markProjectOpened(store: KeyValueStore, uid: string, projectId: string): string[] {
  const current = readOpenedProjects(store, uid);
  if (current.includes(projectId)) return current;
  const next = [...current, projectId];
  try {
    store.setItem(key(uid), JSON.stringify(next));
  } catch {
    /* storage blocked: the hint is lost on restart, nothing else */
  }
  return next;
}

export interface PickerEntry {
  id: string;
  name: string;
  role: string;
  /** False when offline and the project was never opened on this device. */
  available: boolean;
  reason: string | null;
}

export const AVAILABLE_WHEN_ONLINE = "Available when online";

export function pickerEntries(
  memberships: ReadonlyArray<{ id: string; name?: string; role: string }>,
  opened: readonly string[],
  online: boolean,
): PickerEntry[] {
  return memberships.map((m) => {
    const available = online || opened.includes(m.id);
    return { id: m.id, name: m.name ?? m.id, role: m.role, available, reason: available ? null : AVAILABLE_WHEN_ONLINE };
  });
}
