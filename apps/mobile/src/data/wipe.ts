import { db } from "@ff/data/db/database";
import { ACTIVE_OUTBOX_STATES } from "@ff/tasks";
import { getBlobStore, type BlobStore } from "../storage";

/** localStorage keys owned by this app/@ff/auth that describe the signed-in user. */
const LOCAL_KEY_PREFIXES = ["ff-", "ffm", "emailForSignIn"];

/** Rows still waiting to reach the server (added / sending / failed), all projects. */
export async function countUnsyncedOutbox(): Promise<number> {
  return db.outbox.where("state").anyOf(ACTIVE_OUTBOX_STATES as string[]).count();
}

export interface WipeDeps {
  /** Stop listeners / close connections that would block database deletion. */
  closeConnections(): Promise<void>;
  /** Every IndexedDB database name (Dexie, Firestore cache, ...). */
  listDatabases(): Promise<string[]>;
  deleteDatabase(name: string): Promise<void>;
  blobStore: BlobStore;
  localStorageKeys(): string[];
  removeLocalStorageKey(key: string): void;
}

export interface WipeReport {
  databases: string[];
  blobs: number;
  prefs: number;
  errors: string[];
}

/** Delete every local copy of project data. Never throws: failures are reported. */
export async function wipeLocalData(deps: WipeDeps): Promise<WipeReport> {
  const report: WipeReport = { databases: [], blobs: 0, prefs: 0, errors: [] };
  const attempt = async (label: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      report.errors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  await attempt("close", () => deps.closeConnections());
  await attempt("databases", async () => {
    for (const name of await deps.listDatabases()) {
      await attempt(`db ${name}`, async () => {
        await deps.deleteDatabase(name);
        report.databases.push(name);
      });
    }
  });
  await attempt("blobs", async () => {
    for (const entry of await deps.blobStore.list()) {
      if (await deps.blobStore.delete(entry.key)) report.blobs += 1;
    }
  });
  for (const key of deps.localStorageKeys()) {
    if (LOCAL_KEY_PREFIXES.some((p) => key.startsWith(p))) {
      deps.removeLocalStorageKey(key);
      report.prefs += 1;
    }
  }
  return report;
}

/** Real dependencies: IndexedDB + Capacitor BlobStore + localStorage. */
export function browserWipeDeps(closeConnections: () => Promise<void>): WipeDeps {
  return {
    closeConnections: async () => {
      db.close();
      await closeConnections();
    },
    listDatabases: async () => {
      const list = (await indexedDB.databases?.()) ?? [];
      return list.map((d) => d.name).filter((n): n is string => !!n);
    },
    deleteDatabase: (name) =>
      new Promise<void>((resolve, reject) => {
        const req = indexedDB.deleteDatabase(name);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error ?? new Error("deleteDatabase failed"));
        // Blocked deletes finish once the page reloads and the connection closes.
        req.onblocked = () => resolve();
      }),
    blobStore: getBlobStore(),
    localStorageKeys: () => Object.keys(window.localStorage),
    removeLocalStorageKey: (k) => window.localStorage.removeItem(k),
  };
}
