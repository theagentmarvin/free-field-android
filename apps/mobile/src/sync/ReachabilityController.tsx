import { useEffect } from "react";
import { isDemoAuth } from "@ff/auth";
import { useTaskEngine } from "@ff/tasks-react";
import { useNetworkStatus } from "../platform/network";
import { getReachability } from "../platform/reachability";
import { outboxCounts } from "./outboxModel";
import { useOutboxRows } from "./useOutbox";

/**
 * Feeds the reachability monitor (BUG-02): the OS link state, the number of waiting outbox rows and the outbox engine's own
 * reachability signal (primary input). The monitor probes the backend only while work is waiting (with backoff); nothing
 * runs while idle. Demo mode has no backend, so the chip stays at the OS state there.
 */
export function ReachabilityController() {
  const { online } = useNetworkStatus();
  const engine = useTaskEngine();
  const pending = outboxCounts(useOutboxRows()).pending;
  const demo = isDemoAuth();
  const monitor = getReachability();

  useEffect(() => {
    monitor.setContext({ online, pending: demo ? 0 : pending });
  }, [monitor, online, pending, demo]);

  useEffect(() => {
    if (!engine || demo) return;
    const apply = (state: "ok" | "unreachable" | "unknown") => {
      if (state === "ok") monitor.markReachable();
      else monitor.setEvidence("outbox", state === "unreachable");
    };
    apply(engine.getReachability().state);
    return engine.subscribeReachability((r) => apply(r.state));
  }, [monitor, engine, demo]);
  return null;
}
