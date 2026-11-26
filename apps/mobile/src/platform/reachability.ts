import { useSyncExternalStore } from "react";

/**
 * Backend reachability (BUG-02). The OS link state says "connected" on a captive portal or a site LAN
 * without an uplink, so the chip also needs to know whether the backend can actually be reached.
 *
 * Evidence comes from named sources:
 *   - "outbox":   the outbox engine's own reachability signal (`OutboxEngine.subscribeReachability`, w74): "unreachable"
 *                 after a network-class drain failure, "ok" after a commit succeeded. Primary input.
 *   - "download": the download manager saw a network-class failure or stall (cleared once bytes flow again)
 *   - "probe":    a cheap request to the backend, only while work is pending, with backoff (never while idle); a
 *                 backup for the window before the first drain attempt has failed
 * A successful probe or an outbox "ok" is a fresh observation and clears the older evidence.
 */
export type EvidenceSource = "outbox" | "download" | "probe";

/** What a reachability producer looks like: the outbox signal can be adapted to this later. */
export interface ReachabilitySignal {
  /** True while the producer believes the backend is unreachable. */
  unreachable(): boolean;
  subscribe(cb: () => void): () => void;
}

export interface MonitorDeps {
  /** One cheap request to the backend; resolves true when something answered, false on a network failure. */
  probe(): Promise<boolean>;
  setTimeout?(cb: () => void, ms: number): unknown;
  clearTimeout?(h: unknown): void;
  /** The backend became reachable again while work was waiting: nudge the outbox. */
  onRecovered?(): void;
  /** First probe delay after work starts waiting (ms). */
  firstProbeMs?: number;
  /** Delays after a failed probe, last one repeats. */
  backoffMs?: readonly number[];
}

export const FIRST_PROBE_MS = 1_500;
export const PROBE_BACKOFF_MS = [5_000, 10_000, 20_000, 40_000, 60_000] as const;

export class ReachabilityMonitor implements ReachabilitySignal {
  private evidence: Record<EvidenceSource, boolean> = { outbox: false, download: false, probe: false };
  private listeners = new Set<() => void>();
  private online = true;
  private pending = 0;
  private timer: unknown = null;
  private inflight = false;
  private failures = 0;
  /** A probe succeeded for the current wait: do not probe again until the situation changes. */
  private settled = false;
  private epoch = 0;

  constructor(private deps: MonitorDeps) {}

  private st(cb: () => void, ms: number) {
    return (this.deps.setTimeout ?? setTimeout)(cb, ms);
  }
  private ct(h: unknown) {
    (this.deps.clearTimeout ?? clearTimeout)(h as never);
  }

  unreachable = (): boolean => this.online && (this.evidence.outbox || this.evidence.download || this.evidence.probe);

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  private emit() {
    this.listeners.forEach((l) => l());
  }

  setEvidence(source: EvidenceSource, unreachable: boolean): void {
    if (this.evidence[source] === unreachable) return;
    const before = this.unreachable();
    this.evidence[source] = unreachable;
    if (unreachable && source !== "probe") this.settled = false;
    this.reschedule();
    if (before !== this.unreachable()) this.emit();
  }

  /** A fresh positive observation (a commit succeeded): clear every piece of evidence. */
  markReachable(): void {
    const before = this.unreachable();
    this.evidence = { outbox: false, download: false, probe: false };
    this.failures = 0;
    this.reschedule();
    if (before !== this.unreachable()) this.emit();
  }

  /** Network state and amount of waiting work. Probing happens only while online and (pending > 0 or download evidence). */
  setContext(ctx: { online: boolean; pending: number }): void {
    const before = this.unreachable();
    const onlineFlip = ctx.online !== this.online;
    const grew = ctx.pending > this.pending;
    this.online = ctx.online;
    this.pending = ctx.pending;
    if (onlineFlip || grew) {
      this.settled = false;
      this.failures = 0;
    }
    if (!ctx.online) this.evidence.probe = false; // offline wins; probe evidence is stale
    if (ctx.pending === 0 && !this.evidence.download) {
      // Idle: nothing is waiting, so stale suspicion is dropped (no polling while idle).
      this.evidence.probe = false;
      this.evidence.outbox = false;
    }
    this.reschedule();
    if (before !== this.unreachable()) this.emit();
  }

  private wantsProbe(): boolean {
    return this.online && (this.pending > 0 || this.evidence.download) && !this.settled;
  }

  private reschedule(): void {
    if (!this.wantsProbe()) {
      if (this.timer !== null) this.ct(this.timer);
      this.timer = null;
      this.epoch++;
      return;
    }
    if (this.timer !== null || this.inflight) return;
    const backoff = this.deps.backoffMs ?? PROBE_BACKOFF_MS;
    const delay = this.failures === 0 ? (this.deps.firstProbeMs ?? FIRST_PROBE_MS) : backoff[Math.min(this.failures - 1, backoff.length - 1)];
    this.timer = this.st(() => {
      this.timer = null;
      void this.runProbe();
    }, delay);
  }

  /** Run a probe now (also exposed for tests). */
  async runProbe(): Promise<void> {
    if (!this.wantsProbe() || this.inflight) return;
    this.inflight = true;
    const epoch = this.epoch;
    let ok = false;
    try {
      ok = await this.deps.probe();
    } catch {
      ok = false;
    }
    this.inflight = false;
    if (epoch !== this.epoch && !this.wantsProbe()) return; // the situation changed while the request was out
    const before = this.unreachable();
    if (ok) {
      const wasDown = before;
      this.evidence = { outbox: false, download: false, probe: false };
      this.failures = 0;
      this.settled = true;
      if (wasDown) this.deps.onRecovered?.();
    } else {
      this.evidence.probe = true;
      this.failures++;
    }
    this.reschedule();
    if (before !== this.unreachable()) this.emit();
  }

  dispose(): void {
    if (this.timer !== null) this.ct(this.timer);
    this.timer = null;
    this.listeners.clear();
  }
}

/** Backend URL a no-cors request goes to: the Firestore host, or the local emulator in emulator builds. */
export function defaultProbeUrl(): string {
  if (import.meta.env.VITE_FIREBASE_USE_EMULATOR === "true") {
    return `http://${import.meta.env.VITE_FIREBASE_EMULATOR_HOST || "localhost"}:8080/`;
  }
  return "https://firestore.googleapis.com/";
}

/** Any HTTP answer (even an opaque no-cors one or a 404) means the host is reachable; a network failure or timeout means it is not. */
export function createFetchProbe(url: string = defaultProbeUrl(), timeoutMs = 4_000, fetchImpl: typeof fetch = (...a) => fetch(...a)): () => Promise<boolean> {
  return async () => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      await fetchImpl(url, { method: "GET", mode: "no-cors", cache: "no-store", signal: ctl.signal });
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(t);
    }
  };
}

let shared: ReachabilityMonitor | null = null;
/** The app-wide monitor. `onRecovered` is wired by the sync glue. */
export function getReachability(): ReachabilityMonitor {
  return (shared ??= new ReachabilityMonitor({
    probe: createFetchProbe(),
    onRecovered: () => recoveredHandlers.forEach((h) => h()),
  }));
}
const recoveredHandlers = new Set<() => void>();
export function onBackendRecovered(cb: () => void): () => void {
  recoveredHandlers.add(cb);
  return () => recoveredHandlers.delete(cb);
}

/** Test seam. */
export function __resetReachabilityForTest(): void {
  shared?.dispose();
  shared = null;
}

export type ChipState = "online" | "offline" | "unreachable";

/** Pure: the chip state from the OS link state and the backend signal. */
export function chipState(osOnline: boolean, unreachable: boolean): ChipState {
  if (!osOnline) return "offline";
  return unreachable ? "unreachable" : "online";
}

export const CHIP_LABEL: Record<ChipState, string> = {
  online: "Online",
  offline: "Offline",
  unreachable: "No connection to server",
};

export function useBackendUnreachable(): boolean {
  const m = getReachability();
  return useSyncExternalStore(m.subscribe, m.unreachable, m.unreachable);
}
