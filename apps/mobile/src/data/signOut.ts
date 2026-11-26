import { getFirestore, terminate } from "firebase/firestore";
import type { FirebaseApp } from "firebase/app";
import { browserWipeDeps, wipeLocalData, type WipeReport } from "./wipe";

/**
 * Sign out, wipe local project data, then reload so every in-memory cache
 * (Firestore, Dexie live queries, auth listeners) starts from nothing.
 * The caller shows the confirm that warns about unsynced outbox rows first.
 */
export async function signOutAndWipe(opts: {
  app: FirebaseApp | null;
  signOut: () => Promise<void>;
  afterSignOut?: () => void;
  reload?: () => void;
}): Promise<WipeReport> {
  await opts.signOut().catch((err) => console.warn("[auth] sign-out failed", err));
  opts.afterSignOut?.();
  const report = await wipeLocalData(
    browserWipeDeps(async () => {
      if (opts.app && typeof opts.app === "object" && "options" in opts.app) {
        await terminate(getFirestore(opts.app)).catch(() => undefined);
      }
    }),
  );
  (opts.reload ?? (() => window.location.reload()))();
  return report;
}
