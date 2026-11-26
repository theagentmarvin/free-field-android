import { testHooksEnabled } from "../dev/flag";

/**
 * Disposal bookkeeping. A {@link DisposalBag} owns everything one model session creates
 * (listeners, timers, observers, engine handles) and releases it exactly once, newest first.
 * The {@link ViewerRegistry} enforces "one model at a time": a second acquire while one is live
 * is reported, and the counters feed the leak test.
 */
export class DisposalBag {
  private items: { label: string; fn: () => void }[] = [];
  private done = false;
  errors: { label: string; error: unknown }[] = [];

  get size(): number {
    return this.items.length;
  }
  get disposed(): boolean {
    return this.done;
  }

  /** Register a cleanup. If the bag is already disposed the cleanup runs immediately. */
  add(label: string, fn: () => void): void {
    if (this.done) return this.run(label, fn);
    this.items.push({ label, fn });
  }

  addListener(target: EventTarget, type: string, handler: EventListenerOrEventListenerObject, opts?: boolean | AddEventListenerOptions): void {
    target.addEventListener(type, handler, opts);
    this.add(`listener:${type}`, () => target.removeEventListener(type, handler, opts));
  }

  private run(label: string, fn: () => void): void {
    try {
      fn();
    } catch (error) {
      this.errors.push({ label, error });
    }
  }

  dispose(): void {
    if (this.done) return;
    this.done = true;
    const items = this.items;
    this.items = [];
    for (const it of items.reverse()) this.run(it.label, it.fn);
  }
}

export interface ViewerRegistryStats {
  live: number;
  peak: number;
  acquired: number;
  released: number;
  /** acquires that happened while another viewer was still live */
  overlaps: number;
}

export class ViewerRegistry {
  private liveIds = new Set<symbol>();
  private s: ViewerRegistryStats = { live: 0, peak: 0, acquired: 0, released: 0, overlaps: 0 };
  private waiters = new Set<() => void>();

  /** Returns an idempotent release function. */
  acquire(): () => void {
    const id = Symbol("viewer");
    if (this.liveIds.size > 0) this.s.overlaps++;
    this.liveIds.add(id);
    this.s.acquired++;
    this.s.live = this.liveIds.size;
    this.s.peak = Math.max(this.s.peak, this.s.live);
    return () => {
      if (!this.liveIds.delete(id)) return;
      this.s.released++;
      this.s.live = this.liveIds.size;
      if (this.liveIds.size === 0) {
        const w = [...this.waiters];
        this.waiters.clear();
        for (const f of w) f();
      }
    };
  }

  /** Resolves when no viewer is live (immediately when none is). Gives up after `timeoutMs`. */
  whenIdle(timeoutMs = 4000): Promise<boolean> {
    if (this.liveIds.size === 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.waiters.delete(done);
        resolve(false);
      }, timeoutMs);
      const done = () => {
        clearTimeout(t);
        resolve(true);
      };
      this.waiters.add(done);
    });
  }

  stats(): ViewerRegistryStats {
    return { ...this.s };
  }
}

export const viewerRegistry = new ViewerRegistry();

// e2e seam (test builds only): the registry outlives the model screen, so a spec can prove no viewer is left after a screen that took one.
if (typeof window !== "undefined" && testHooksEnabled()) {
  (window as unknown as { __ffmViewerRegistry?: { stats(): ViewerRegistryStats } }).__ffmViewerRegistry = { stats: () => viewerRegistry.stats() };
}
