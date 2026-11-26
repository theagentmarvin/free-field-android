import { describe, expect, it, vi } from "vitest";
import { startSyncController, type SyncControllerDeps } from "./syncController";

function setup(over: Partial<SyncControllerDeps> = {}) {
  let netCb: (o: boolean) => void = () => undefined;
  let resumeCb: () => void = () => undefined;
  const offNet = vi.fn();
  const offResume = vi.fn();
  const engine = { drain: vi.fn(async () => undefined), reviveNetworkFailed: vi.fn(async () => 0) };
  const deps: SyncControllerDeps = {
    engine,
    onOnlineChange: (cb) => {
      netCb = cb;
      return offNet;
    },
    onResume: (cb) => {
      resumeCb = cb;
      return offResume;
    },
    refreshNetwork: vi.fn(async () => undefined),
    isOnline: () => true,
    ...over,
  };
  const stop = startSyncController(deps);
  return { engine, deps, stop, fireNet: (o: boolean) => netCb(o), fireResume: () => resumeCb(), offNet, offResume };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("startSyncController", () => {
  it("revives network failures then drains when the network returns", async () => {
    const t = setup();
    t.fireNet(true);
    await flush();
    expect(t.engine.reviveNetworkFailed).toHaveBeenCalledTimes(1);
    expect(t.engine.drain).toHaveBeenCalledTimes(1);
    expect(t.engine.reviveNetworkFailed.mock.invocationCallOrder[0]).toBeLessThan(t.engine.drain.mock.invocationCallOrder[0]);
  });
  it("does nothing when the network drops", async () => {
    const t = setup();
    t.fireNet(false);
    await flush();
    expect(t.engine.reviveNetworkFailed).not.toHaveBeenCalled();
    expect(t.engine.drain).not.toHaveBeenCalled();
  });
  it("re-reads connectivity on resume and drains when online", async () => {
    const t = setup();
    t.fireResume();
    await flush();
    expect(t.deps.refreshNetwork).toHaveBeenCalled();
    expect(t.engine.drain).toHaveBeenCalledTimes(1);
  });
  it("does not drain on resume while offline", async () => {
    const t = setup({ isOnline: () => false });
    t.fireResume();
    await flush();
    expect(t.engine.drain).not.toHaveBeenCalled();
  });
  it("reports engine errors instead of throwing, and unsubscribes on stop", async () => {
    const onError = vi.fn();
    const t = setup({ onError });
    t.engine.reviveNetworkFailed.mockRejectedValueOnce(new Error("boom"));
    t.fireNet(true);
    await flush();
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    t.stop();
    expect(t.offNet).toHaveBeenCalled();
    expect(t.offResume).toHaveBeenCalled();
  });
});
