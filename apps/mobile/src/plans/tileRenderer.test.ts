import { describe, expect, it } from "vitest";
import { MemoryBlobStore } from "../storage";
import { manifestKey, parseManifest, tileKey, tilePrefix } from "./manifest";
import { renderTilePyramid, RenderCancelledError, type RasterBackend, type RenderProgress } from "./tileRenderer";
import { planLevels, selectLevel, totalTiles } from "./tileMath";

interface Spy {
  regions: { z: number; px: number; py: number; w: number; h: number }[];
  open: number;
  maxOpen: number;
  released: number;
}

function fakeBackend(spy: Spy, opts: { failAfterTiles?: number } = {}): RasterBackend {
  let tiles = 0;
  return {
    async renderRegion(level, px, py, w, h) {
      spy.regions.push({ z: level.z, px, py, w, h });
      spy.open++;
      spy.maxOpen = Math.max(spy.maxOpen, spy.open);
      return {
        async encodeTile(sx, sy, tw, th) {
          if (opts.failAfterTiles !== undefined && tiles >= opts.failAfterTiles) throw new Error("boom");
          tiles++;
          expect(sx + tw).toBeLessThanOrEqual(w);
          expect(sy + th).toBeLessThanOrEqual(h);
          return new Uint8Array([level.z, tw & 255, th & 255, 1]);
        },
        release() {
          spy.open--;
          spy.released++;
        },
      };
    },
  };
}
const newSpy = (): Spy => ({ regions: [], open: 0, maxOpen: 0, released: 0 });
const base = { planVersionId: "v1", sha256: "h1", pageWidth: 2384, pageHeight: 1684, yieldFn: async () => undefined };

describe("renderTilePyramid", () => {
  it("writes every tile of every level plus a complete manifest", async () => {
    const store = new MemoryBlobStore();
    const spy = newSpy();
    const progress: RenderProgress[] = [];
    const m = await renderTilePyramid({ ...base, store, backend: fakeBackend(spy), onProgress: (p) => progress.push(p) });
    expect(m.complete).toBe(true);
    const levels = planLevels(2384, 1684);
    const files = (await store.list(tilePrefix("v1"))).filter((s) => s.key.endsWith(".webp"));
    expect(files).toHaveLength(totalTiles(levels));
    for (const l of levels) {
      expect(await store.stat(tileKey("v1", l.z, l.cols - 1, l.rows - 1))).not.toBeNull();
    }
    const saved = parseManifest(await store.read(manifestKey("v1")));
    expect(saved?.complete).toBe(true);
    expect(saved?.sha256).toBe("h1");
    // progress is monotonic and ends at total
    expect(progress.at(-1)).toMatchObject({ done: totalTiles(levels), total: totalTiles(levels) });
    for (let i = 1; i < progress.length; i++) expect(progress[i].done).toBeGreaterThanOrEqual(progress[i - 1].done);
    // coarse levels first
    const order = spy.regions.map((r) => r.z);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("keeps one canvas open at a time and respects the pixel cap", async () => {
    const store = new MemoryBlobStore();
    const spy = newSpy();
    const cap = 1024 * 1024;
    await renderTilePyramid({ ...base, store, backend: fakeBackend(spy), maxCanvasPixels: cap });
    expect(spy.maxOpen).toBe(1);
    expect(spy.open).toBe(0);
    expect(spy.released).toBe(spy.regions.length);
    for (const r of spy.regions) expect(r.w * r.h).toBeLessThanOrEqual(cap);
    expect(spy.regions.length).toBeGreaterThan(planLevels(2384, 1684).length); // banded, not one canvas per level
  });

  it("is resumable: a second run renders nothing, an interrupted run only the missing tiles", async () => {
    const store = new MemoryBlobStore();
    const levels = planLevels(2384, 1684);
    const total = totalTiles(levels);

    const s1 = newSpy();
    await expect(renderTilePyramid({ ...base, store, backend: fakeBackend(s1, { failAfterTiles: 20 }) })).rejects.toThrow("boom");
    expect(s1.open).toBe(0); // released after the failure
    const partial = parseManifest(await store.read(manifestKey("v1")));
    expect(partial?.complete).toBe(false);
    const written = (await store.list(tilePrefix("v1"))).filter((s) => s.key.endsWith(".webp")).length;
    expect(written).toBe(20);

    const s2 = newSpy();
    const progress: RenderProgress[] = [];
    await renderTilePyramid({ ...base, store, backend: fakeBackend(s2), onProgress: (p) => progress.push(p) });
    expect(progress.at(-1)?.skipped).toBe(20);
    const rendered = (await store.list(tilePrefix("v1"))).filter((s) => s.key.endsWith(".webp")).length;
    expect(rendered).toBe(total);

    const s3 = newSpy();
    const m = await renderTilePyramid({ ...base, store, backend: fakeBackend(s3) });
    expect(s3.regions).toHaveLength(0); // everything present: no canvas at all
    expect(m.complete).toBe(true);
  });

  it("re-renders a tile that went missing without touching the rest", async () => {
    const store = new MemoryBlobStore();
    await renderTilePyramid({ ...base, store, backend: fakeBackend(newSpy()) });
    await store.delete(tileKey("v1", 1, 0, 0));
    const spy = newSpy();
    await renderTilePyramid({ ...base, store, backend: fakeBackend(spy) });
    expect(spy.regions).toHaveLength(1);
    expect(await store.stat(tileKey("v1", 1, 0, 0))).not.toBeNull();
  });

  it("a different PDF hash discards the old tiles", async () => {
    const store = new MemoryBlobStore();
    await renderTilePyramid({ ...base, store, backend: fakeBackend(newSpy()) });
    const spy = newSpy();
    await renderTilePyramid({ ...base, sha256: "h2", store, backend: fakeBackend(spy) });
    expect(spy.regions.length).toBeGreaterThan(0);
    expect(parseManifest(await store.read(manifestKey("v1")))?.sha256).toBe("h2");
  });

  it("cancels cleanly, leaves a partial manifest and resumes after", async () => {
    const store = new MemoryBlobStore();
    const ctl = new AbortController();
    const spy = newSpy();
    let n = 0;
    await expect(
      renderTilePyramid({
        ...base,
        store,
        backend: fakeBackend(spy),
        signal: ctl.signal,
        onProgress: () => {
          if (++n === 6) ctl.abort();
        },
      }),
    ).rejects.toBeInstanceOf(RenderCancelledError);
    expect(spy.open).toBe(0);
    expect(parseManifest(await store.read(manifestKey("v1")))?.complete).toBe(false);
    const m = await renderTilePyramid({ ...base, store, backend: fakeBackend(newSpy()) });
    expect(m.complete).toBe(true);
  });

  it("already-aborted signal does no work", async () => {
    const ctl = new AbortController();
    ctl.abort();
    const spy = newSpy();
    await expect(renderTilePyramid({ ...base, store: new MemoryBlobStore(), backend: fakeBackend(spy), signal: ctl.signal })).rejects.toBeInstanceOf(RenderCancelledError);
    expect(spy.regions).toHaveLength(0);
  });

  it("handles a huge A0 page with bounded canvases", async () => {
    const store = new MemoryBlobStore();
    const spy = newSpy();
    await renderTilePyramid({ ...base, planVersionId: "a0", pageWidth: 3370, pageHeight: 2384, store, backend: fakeBackend(spy) });
    for (const r of spy.regions) expect(r.w * r.h).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(spy.maxOpen).toBe(1);
  });

  it("runs the preview hook before any tile and publishes the manifest after it", async () => {
    const store = new MemoryBlobStore();
    const events: string[] = [];
    const spy = newSpy();
    await renderTilePyramid({
      ...base,
      store,
      backend: fakeBackend(spy),
      beforeLevels: async () => {
        events.push(`preview(regions=${spy.regions.length})`);
      },
      onManifest: () => events.push(`manifest(regions=${spy.regions.length})`),
    });
    expect(events).toEqual(["preview(regions=0)", "manifest(regions=0)"]);
  });

  it("renders the regions the viewer looks at before the rest of a finer level", async () => {
    const store = new MemoryBlobStore();
    const spy = newSpy();
    const levels = planLevels(2384, 1684);
    const finest = levels[levels.length - 1];
    // looking at the bottom-right corner of the sheet at full resolution
    const rect = { x0: 2000, y0: 1400, x1: 2384, y1: 1684 };
    await renderTilePyramid({ ...base, store, backend: fakeBackend(spy), maxCanvasPixels: 512 * 512, getHint: () => ({ rect, pxPerPoint: finest.scale }) });
    const zs = spy.regions.map((r) => r.z);
    const firstFine = zs.indexOf(finest.z);
    expect(selectLevel(levels, finest.scale).z).toBe(finest.z);
    expect(zs.slice(0, firstFine).every((z) => z === 0)).toBe(true); // level 0 first, then straight to what is visible
    const r = spy.regions[firstFine];
    expect(r.px + r.w).toBeGreaterThan(rect.x0 * finest.scale);
    expect(r.py + r.h).toBeGreaterThan(rect.y0 * finest.scale);
    const m = parseManifest(await store.read(manifestKey("v1")));
    expect(m?.complete).toBe(true);
    expect((await store.list(tilePrefix("v1"))).filter((s) => s.key.endsWith(".webp"))).toHaveLength(totalTiles(levels));
  });
});
