import { describe, expect, it, vi } from "vitest";
import { CostLru } from "./lru";
import { TileCache, tileCost, tileId, type DecodedTile } from "./tileCache";
import { MemoryBlobStore } from "../storage";
import { tileKey } from "./manifest";

describe("CostLru", () => {
  it("evicts least-recently-used entries when over budget", () => {
    const evicted: string[] = [];
    const c = new CostLru<string, number>(100, (k) => evicted.push(k));
    c.set("a", 1, 40);
    c.set("b", 2, 40);
    c.get("a"); // a is now newest
    c.set("c", 3, 40);
    expect(evicted).toEqual(["b"]);
    expect(c.cost).toBe(80);
    expect(c.has("a") && c.has("c") && !c.has("b")).toBe(true);
  });
  it("never evicts the entry just added, even if it alone is over budget", () => {
    const c = new CostLru<string, number>(10);
    c.set("big", 1, 50);
    expect(c.has("big")).toBe(true);
    c.set("x", 2, 5);
    expect(c.has("big")).toBe(false); // old big goes once something newer arrives
  });
  it("honours pinned keys", () => {
    const c = new CostLru<string, number>(100);
    c.set("keep", 1, 60);
    c.set("b", 2, 30);
    c.set("c", 3, 30, new Set(["keep"]));
    expect(c.has("keep")).toBe(true);
    expect(c.has("b")).toBe(false);
  });
  it("replacing a key adjusts cost and releases the old value", () => {
    const evicted: number[] = [];
    const c = new CostLru<string, number>(100, (_k, v) => evicted.push(v));
    c.set("a", 1, 30);
    c.set("a", 2, 50);
    expect(c.cost).toBe(50);
    expect(evicted).toEqual([1]);
    c.clear();
    expect(evicted).toEqual([1, 2]);
    expect(c.size).toBe(0);
  });
  it("peek does not change recency", () => {
    const c = new CostLru<string, number>(80);
    c.set("a", 1, 40);
    c.set("b", 2, 40);
    c.peek("a");
    c.set("c", 3, 40);
    expect(c.has("a")).toBe(false);
  });
});

function fakeTile(): DecodedTile & { closed: boolean } {
  const t = { bitmap: { close: () => void (t.closed = true) } as unknown as ImageBitmap, w: 256, h: 256, closed: false };
  return t;
}

describe("TileCache", () => {
  async function setup(budgetTiles: number, n: number) {
    const store = new MemoryBlobStore();
    for (let i = 0; i < n; i++) await store.write(tileKey("v1", 2, i, 0), new Uint8Array([i + 1]));
    const made: ReturnType<typeof fakeTile>[] = [];
    const onChange = vi.fn();
    const cache = new TileCache(store, "v1", onChange, budgetTiles * tileCost(256, 256), 2, async () => {
      const t = fakeTile();
      made.push(t);
      return t;
    });
    return { cache, made, onChange, store };
  }
  const settle = () => new Promise((r) => setTimeout(r, 20));

  it("stays within the memory budget and closes evicted bitmaps", async () => {
    const { cache, made } = await setup(3, 8);
    cache.request(Array.from({ length: 8 }, (_, i) => ({ z: 2, x: i, y: 0 })));
    await settle();
    expect(cache.bytes).toBeLessThanOrEqual(3 * tileCost(256, 256));
    expect(cache.size).toBe(3);
    expect(made.filter((t) => t.closed)).toHaveLength(5);
  });
  it("skips loaded tiles and notifies on load", async () => {
    const { cache, onChange } = await setup(10, 2);
    cache.request([{ z: 2, x: 0, y: 0 }]);
    await settle();
    expect(onChange).toHaveBeenCalledTimes(1);
    cache.request([{ z: 2, x: 0, y: 0 }]);
    await settle();
    expect(cache.loaded).toBe(1);
  });
  it("remembers missing tiles instead of re-reading them until reset", async () => {
    const { cache, store } = await setup(10, 1);
    const spy = vi.spyOn(store, "read");
    cache.request([{ z: 2, x: 5, y: 5 }]);
    await settle();
    cache.request([{ z: 2, x: 5, y: 5 }]);
    await settle();
    expect(spy).toHaveBeenCalledTimes(1);
    cache.resetMisses();
    cache.request([{ z: 2, x: 5, y: 5 }]);
    await settle();
    expect(spy).toHaveBeenCalledTimes(2);
  });
  it("a new request replaces queued (stale) work", async () => {
    const { cache, store } = await setup(20, 10);
    const spy = vi.spyOn(store, "read");
    cache.request(Array.from({ length: 10 }, (_, i) => ({ z: 2, x: i, y: 0 }))); // 2 start, 8 queued
    cache.request([{ z: 2, x: 9, y: 0 }]); // supersedes the queue
    await settle();
    expect(spy.mock.calls.length).toBeLessThanOrEqual(3);
  });
  it("dispose closes everything and ignores late decodes", async () => {
    const { cache, made } = await setup(10, 4);
    cache.request([0, 1, 2, 3].map((x) => ({ z: 2, x, y: 0 })));
    await settle();
    cache.dispose();
    expect(made.every((t) => t.closed)).toBe(true);
    expect(cache.size).toBe(0);
  });
  it("tileId format", () => {
    expect(tileId(3, 4, 5)).toBe("3/4_5");
  });
});
