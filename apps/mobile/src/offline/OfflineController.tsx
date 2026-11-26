import { useEffect } from "react";
import { App as CapApp } from "@capacitor/app";
import { getFirestore } from "firebase/firestore";
import { getStorage } from "firebase/storage";
import { isDemoAuth, useAuthContext } from "@ff/auth";
import { db } from "@ff/data/db/database";
import { createSyncEngine, type SyncEngine } from "@ff/sync";
import { createFirestoreRemote } from "@ff/sync/firebase";
import { onNetworkChange, onOnlineChange, refreshNetwork } from "../platform/network";
import { createMobileBlobSink, chunkedHasher, createStreamingTransport, createUrlProvider } from "./engineBridge";
import { files, getDownloadManager, setUrlProvider } from "./instance";

let current: SyncEngine | null = null;
/** The running sync engine (null in demo mode / signed out). */
export const getSyncEngine = () => current;

/**
 * Runs the metadata sync engine for the current project and the offline download manager.
 *  - engine: started per project (admins may write, members only listen); stopped on project switch / sign-out
 *  - manager: resumes interrupted downloads, pauses on Wi-Fi loss, checks for newer versions after each down-sync
 *  - foreground: on app resume and network regain the engine drains/down-syncs and updates are re-checked
 */
export function OfflineController() {
  const { app, user, project } = useAuthContext();
  const projectId = project?.id ?? null;
  const canWrite = project?.role === "admin";
  const uid = user?.uid ?? null;

  useEffect(() => {
    if (!projectId || !uid || isDemoAuth() || !app) return;
    const manager = getDownloadManager();
    const storage = getStorage(app);
    const urlFor = createUrlProvider(storage);
    setUrlProvider(urlFor);
    const engine = createSyncEngine({
      db,
      remote: createFirestoreRemote(getFirestore(app)),
      transport: createStreamingTransport({ files, storage, urlFor }),
      uid,
      isOnline: () => navigator.onLine,
      sink: createMobileBlobSink(files),
      hash: chunkedHasher,
    });
    current = engine;
    void engine.start(projectId, { canWrite }).catch((e) => console.warn("[sync] start failed", e));
    // The connection type must be known before the manager decides whether it may resume (Wi-Fi only).
    void refreshNetwork()
      .then(() => manager.setProject(projectId))
      .then(() => manager.checkUpdates())
      .catch((e) => console.warn("[offline] start failed", e));

    let timer: ReturnType<typeof setTimeout> | undefined;
    const offEvents = engine.subscribe((e) => {
      if (e.type === "down-applied" && /Versions|Files/.test(e.collection) && (e.upserted > 0 || e.deleted > 0)) {
        clearTimeout(timer);
        timer = setTimeout(() => void manager.checkUpdates().catch(() => undefined), 1000);
      }
    });
    const foreground = () => {
      void engine.notifyOnline().catch(() => undefined);
      void manager.onNetworkChange().catch(() => undefined);
    };
    const offOnline = onOnlineChange((on) => on && foreground());
    const offNet = onNetworkChange(() => void manager.onNetworkChange().catch(() => undefined));
    const resume = CapApp.addListener("resume", () => void refreshNetwork().then(foreground));

    return () => {
      clearTimeout(timer);
      offEvents();
      offOnline();
      offNet();
      void resume.then((h) => h.remove());
      engine.stop();
      engine.dispose();
      if (current === engine) current = null;
      setUrlProvider(null);
      void manager.setProject(null); // downloads of this project stop; parts stay for the next visit
    };
  }, [app, uid, projectId, canWrite]);

  return null;
}
