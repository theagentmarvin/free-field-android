import { useEffect } from "react";
import { App as CapApp } from "@capacitor/app";
import { useTaskEngine } from "@ff/tasks-react";
import { onOnlineChange, refreshNetwork } from "../platform/network";
import { onBackendRecovered } from "../platform/reachability";
import { startSyncController } from "./syncController";

/** Mounts the shared outbox engine at startup (cold-start repair + drain) and wires events to it. */
export function SyncController() {
  const engine = useTaskEngine();
  useEffect(() => {
    if (!engine) return;
    // The probe found the backend again while work was waiting: revive network-failed rows and drain.
    const offRecovered = onBackendRecovered(() => void engine.resumeNow().catch(() => undefined));
    const stop = startSyncController({
      engine,
      onOnlineChange,
      onResume: (cb) => {
        const sub = CapApp.addListener("resume", cb);
        return () => void sub.then((h) => h.remove());
      },
      refreshNetwork,
      isOnline: () => navigator.onLine,
      onError: (err) => console.warn("[sync] controller error", err),
    });
    return () => {
      offRecovered();
      stop();
    };
  }, [engine]);
  return null;
}
