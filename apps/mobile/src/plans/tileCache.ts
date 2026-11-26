import type { BlobStore } from "../storage";
import { CostLru } from "./lru";
import { tileKey } from "./manifest";

export interface DecodedTile {
  bitmap: ImageBitmap;
  w: number;
  h: number;
}

export const tileCost = (w: number, h: number) => w * h * 4;

export const DEFAULT_TILE_BUDGET = 64 * 1024 * 1024;

export type TileId = string;
export const tileId = (z: number, x: number, y: number): TileId => `${z}/${x}_${y}`;

/**
 * Decoded-tile cache for the viewer: BlobStore -> ImageBitmap with an LRU memory
 * budget and a bounded, re-prioritizable load queue (stale requests are dropped
 * when the view moves on).
 */
export class TileCache {
  private lru: CostLru<TileId, DecodedTile>;
  private inflight = new Set<TileId>();
  private queue: { id: TileId; z: number; x: number; y: number }[] = [];
  private active = 0;
  private disposed = false;
  /** Tiles whose blob is missing (not rendered yet); not retried until `resetMisses`. */
  private missing = new Set<TileId>();
  loaded = 0;

  constructor(
    private readonly store: BlobStore,
    private readonly planVersionId: string,
    private readonly onChange: () => void,
    budgetBytes = DEFAULT_TILE_BUDGET,
    private readonly concurrency = 4,
    private readonly decode: (bytes: Uint8Array) => Promise<DecodedTile> = decodeWebp,
  ) {
    this.lru = new CostLru(budgetBytes, (_k, t) => t.bitmap.close?.());
  }

  get size(): number {
    return this.lru.size;
  }
  get bytes(): number {
    return this.lru.cost;
  }

  get(id: TileId): DecodedTile | undefined {
    return this.lru.get(id);
  }
  peek(id: TileId): DecodedTile | undefined {
    return this.lru.peek(id);
  }

  /**
   * Replace the pending queue with `wanted` (most important first). In-flight
   * loads continue; queued ones not in the new list are forgotten.
   */
  request(wanted: { z: number; x: number; y: number }[]): void {
    this.queue = [];
    for (const t of wanted) {
      const id = tileId(t.z, t.x, t.y);
      if (this.lru.has(id) || this.inflight.has(id) || this.missing.has(id)) continue;
      this.queue.push({ id, ...t });
    }
    this.pump();
  }

  resetMisses(): void {
    this.missing.clear();
  }

  private pump(): void {
    while (!this.disposed && this.active < this.concurrency && this.queue.length > 0) {
      const next = this.queue.shift()!;
      this.active++;
      this.inflight.add(next.id);
      void this.load(next).finally(() => {
        this.active--;
        this.inflight.delete(next.id);
        this.pump();
      });
    }
  }

  private async load(t: { id: TileId; z: number; x: number; y: number }): Promise<void> {
    try {
      const bytes = await this.store.read(tileKey(this.planVersionId, t.z, t.x, t.y));
      if (!bytes) {
        this.missing.add(t.id);
        return;
      }
      const tile = await this.decode(bytes);
      if (this.disposed) {
        tile.bitmap.close?.();
        return;
      }
      this.lru.set(t.id, tile, tileCost(tile.w, tile.h));
      this.loaded++;
      this.onChange();
    } catch (e) {
      this.missing.add(t.id);
      console.warn("[plans] tile load failed", t.id, e);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.queue = [];
    this.lru.clear();
  }
}

async function decodeWebp(bytes: Uint8Array): Promise<DecodedTile> {
  const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: "image/webp" }));
  return { bitmap, w: bitmap.width, h: bitmap.height };
}
