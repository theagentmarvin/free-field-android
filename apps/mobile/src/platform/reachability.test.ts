import { describe, expect, it, vi } from "vitest";
import { CHIP_LABEL, ReachabilityMonitor, chipState, createFetchProbe } from "./reachability";

/** Manual timers so backoff is deterministic. */
function harness(probeResults: boolean[]) {
  const timers: Array<{ cb: () => void; ms: number; live: boolean }> = [];
  const probe = vi.fn(async () => probeResults.shift() ?? true);
  const recovered = vi.fn();
  const m = new ReachabilityMonitor({
    probe,
    onRecovered: recovered,
    setTimeout: (cb, ms) => {
      const t = { cb, ms, live: true };
      timers.push(t);
      return t;
    },
    clearTimeout: (h) => {
      (h as { live: boolean }).live = false;
    },
  });
  const fire = async () => {
    const t = timers.filter((x) => x.live).at(-1);
    if (!t) throw new Error("no timer");
    t.live = false;
    t.cb();
    await new Promise((r) => setTimeout(r, 0));
    return t.ms;
  };
  const live = () => timers.filter((t) => t.live).length;
  return { m, probe, recovered, fire, live };
}

describe("chip state", () => {
  it("offline beats everything; online + unreachable is its own state", () => {
    expect(chipState(false, true)).toBe("offline");
    expect(chipState(true, true)).toBe("unreachable");
    expect(chipState(true, false)).toBe("online");
    expect(CHIP_LABEL).toEqual({ online: "Online", offline: "Offline", unreachable: "No connection to server" });
  });
});

describe("ReachabilityMonitor", () => {
  it("never probes while idle", () => {
    const h = harness([]);
    h.m.setContext({ online: true, pending: 0 });
    expect(h.live()).toBe(0);
    expect(h.probe).not.toHaveBeenCalled();
    expect(h.m.unreachable()).toBe(false);
  });

  it("probes once when work waits; a reachable answer stops further probing", async () => {
    const h = harness([true]);
    h.m.setContext({ online: true, pending: 1 });
    expect(await h.fire()).toBe(1500);
    expect(h.m.unreachable()).toBe(false);
    expect(h.live()).toBe(0);
    expect(h.probe).toHaveBeenCalledTimes(1);
  });

  it("failed probes mark unreachable and back off 5,10,20,40,60,60 s; recovery fires onRecovered and clears", async () => {
    const h = harness([false, false, false, false, false, false, true]);
    const seen: boolean[] = [];
    h.m.subscribe(() => seen.push(h.m.unreachable()));
    h.m.setContext({ online: true, pending: 1 });
    const delays: number[] = [await h.fire()];
    expect(h.m.unreachable()).toBe(true);
    for (let i = 0; i < 6; i++) delays.push(await h.fire());
    expect(delays).toEqual([1500, 5000, 10000, 20000, 40000, 60000, 60000]);
    expect(h.m.unreachable()).toBe(false);
    expect(h.recovered).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([true, false]);
    expect(h.live()).toBe(0);
  });

  it("offline is not 'unreachable' and stops probing; going idle clears suspicion", async () => {
    const h = harness([false]);
    h.m.setContext({ online: true, pending: 1 });
    await h.fire();
    expect(h.m.unreachable()).toBe(true);
    h.m.setContext({ online: false, pending: 1 });
    expect(h.m.unreachable()).toBe(false);
    expect(h.live()).toBe(0);
    h.m.setContext({ online: true, pending: 0 });
    expect(h.m.unreachable()).toBe(false);
  });

  it("outbox evidence marks unreachable at once; markReachable (a commit succeeded) clears every source", () => {
    const h = harness([]);
    h.m.setContext({ online: true, pending: 1 });
    h.m.setEvidence("outbox", true);
    h.m.setEvidence("download", true);
    expect(h.m.unreachable()).toBe(true);
    h.m.markReachable();
    expect(h.m.unreachable()).toBe(false);
  });

  it("download evidence alone (no outbox work) triggers a probe and recovers", async () => {
    const h = harness([true]);
    h.m.setContext({ online: true, pending: 0 });
    h.m.setEvidence("download", true);
    expect(h.m.unreachable()).toBe(true);
    await h.fire();
    expect(h.m.unreachable()).toBe(false);
    expect(h.recovered).toHaveBeenCalled();
  });
});

describe("fetch probe", () => {
  it("any answer is reachable, a network failure or timeout is not", async () => {
    expect(await createFetchProbe("http://x/", 50, (async () => new Response(null, { status: 404 })) as typeof fetch)()).toBe(true);
    expect(await createFetchProbe("http://x/", 50, (async () => { throw new TypeError("Failed to fetch"); }) as typeof fetch)()).toBe(false);
    const hang = ((_u: string, o: RequestInit) => new Promise((_, rej) => o.signal!.addEventListener("abort", () => rej(new Error("aborted"))))) as unknown as typeof fetch;
    expect(await createFetchProbe("http://x/", 30, hang)()).toBe(false);
  });
});
