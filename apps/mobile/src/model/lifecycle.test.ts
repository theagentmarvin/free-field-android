import { describe, expect, it, vi } from "vitest";
import { DisposalBag, ViewerRegistry } from "./lifecycle";
import { BackgroundGuard, heapPressure } from "./backgroundGuard";

describe("DisposalBag", () => {
  it("runs cleanups newest first, exactly once", () => {
    const bag = new DisposalBag();
    const order: string[] = [];
    bag.add("a", () => order.push("a"));
    bag.add("b", () => order.push("b"));
    expect(bag.size).toBe(2);
    bag.dispose();
    bag.dispose();
    expect(order).toEqual(["b", "a"]);
    expect(bag.size).toBe(0);
    expect(bag.disposed).toBe(true);
  });

  it("keeps going when a cleanup throws and records it", () => {
    const bag = new DisposalBag();
    const ran = vi.fn();
    bag.add("first", ran);
    bag.add("boom", () => {
      throw new Error("x");
    });
    bag.dispose();
    expect(ran).toHaveBeenCalledOnce();
    expect(bag.errors.map((e) => e.label)).toEqual(["boom"]);
  });

  it("runs a cleanup added after disposal immediately", () => {
    const bag = new DisposalBag();
    bag.dispose();
    const fn = vi.fn();
    bag.add("late", fn);
    expect(fn).toHaveBeenCalledOnce();
  });

  it("removes event listeners it added", () => {
    const t = new EventTarget();
    const fn = vi.fn();
    const bag = new DisposalBag();
    bag.addListener(t, "x", fn);
    t.dispatchEvent(new Event("x"));
    bag.dispose();
    t.dispatchEvent(new Event("x"));
    expect(fn).toHaveBeenCalledOnce();
  });
});

describe("ViewerRegistry", () => {
  it("counts live sessions and reports overlap", () => {
    const r = new ViewerRegistry();
    const a = r.acquire();
    expect(r.stats().live).toBe(1);
    const b = r.acquire(); // second while the first is alive
    expect(r.stats()).toMatchObject({ live: 2, peak: 2, overlaps: 1 });
    a();
    a(); // idempotent
    b();
    expect(r.stats()).toMatchObject({ live: 0, acquired: 2, released: 2 });
  });

  it("ten open/close cycles leave nothing live and never overlap", () => {
    const r = new ViewerRegistry();
    for (let i = 0; i < 10; i++) r.acquire()();
    expect(r.stats()).toMatchObject({ live: 0, peak: 1, acquired: 10, released: 10, overlaps: 0 });
  });

  it("whenIdle resolves on release, immediately when idle, and times out", async () => {
    const r = new ViewerRegistry();
    await expect(r.whenIdle()).resolves.toBe(true);
    const rel = r.acquire();
    const p = r.whenIdle(1000);
    rel();
    await expect(p).resolves.toBe(true);
    r.acquire();
    await expect(r.whenIdle(10)).resolves.toBe(false);
  });
});

describe("BackgroundGuard", () => {
  function make(ms = 1000) {
    const timers = new Map<number, { cb: () => void; ms: number }>();
    let id = 0;
    const onRelease = vi.fn();
    const onRestore = vi.fn();
    const g = new BackgroundGuard({
      releaseAfterMs: () => ms,
      setTimer: (cb, t) => {
        timers.set(++id, { cb, ms: t });
        return id;
      },
      clearTimer: (t) => void timers.delete(t as number),
      onRelease,
      onRestore,
    });
    const fire = () => {
      const [k, v] = [...timers][0];
      timers.delete(k);
      v.cb();
    };
    return { g, timers, fire, onRelease, onRestore };
  }

  it("a quick app switch releases nothing", () => {
    const h = make();
    h.g.hidden();
    h.g.visible();
    expect(h.timers.size).toBe(0);
    expect(h.onRelease).not.toHaveBeenCalled();
    expect(h.onRestore).not.toHaveBeenCalled();
  });

  it("releases after the delay and restores on return", () => {
    const h = make(500);
    h.g.hidden();
    h.g.hidden(); // repeated hidden events do not stack timers
    expect(h.timers.size).toBe(1);
    h.fire();
    expect(h.onRelease).toHaveBeenCalledOnce();
    expect(h.g.isReleased).toBe(true);
    h.g.visible();
    expect(h.onRestore).toHaveBeenCalledOnce();
    expect(h.g.isReleased).toBe(false);
    h.g.visible();
    expect(h.onRestore).toHaveBeenCalledOnce();
  });

  it("dispose clears a pending release", () => {
    const h = make();
    h.g.hidden();
    h.g.dispose();
    expect(h.timers.size).toBe(0);
  });

  it("heapPressure is a ratio or null", () => {
    expect(heapPressure({ usedJSHeapSize: 50, jsHeapSizeLimit: 200 })).toBe(0.25);
    expect(heapPressure(undefined)).toBeNull();
    expect(heapPressure({ usedJSHeapSize: 1, jsHeapSizeLimit: 0 })).toBeNull();
  });
});
