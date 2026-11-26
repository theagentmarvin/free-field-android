/** Cost-bounded LRU (cost = bytes). `onEvict` lets the owner release GPU/bitmap memory. */
export class CostLru<K, V> {
  private map = new Map<K, { value: V; cost: number }>();
  private total = 0;

  constructor(
    private readonly budget: number,
    private readonly onEvict?: (key: K, value: V) => void,
  ) {}

  get size(): number {
    return this.map.size;
  }
  get cost(): number {
    return this.total;
  }
  has(key: K): boolean {
    return this.map.has(key);
  }

  /** Read and mark most-recently-used. */
  get(key: K): V | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    this.map.delete(key);
    this.map.set(key, e);
    return e.value;
  }

  /** Read without touching recency. */
  peek(key: K): V | undefined {
    return this.map.get(key)?.value;
  }

  set(key: K, value: V, cost: number, pinned?: ReadonlySet<K>): void {
    const old = this.map.get(key);
    if (old) {
      this.total -= old.cost;
      this.map.delete(key);
      if (old.value !== value) this.onEvict?.(key, old.value);
    }
    this.map.set(key, { value, cost });
    this.total += cost;
    // Evict oldest first, never the entry just added, never `pinned` keys.
    for (const [k, e] of this.map) {
      if (this.total <= this.budget) break;
      if (k === key || pinned?.has(k)) continue;
      this.map.delete(k);
      this.total -= e.cost;
      this.onEvict?.(k, e.value);
    }
  }

  clear(): void {
    for (const [k, e] of this.map) this.onEvict?.(k, e.value);
    this.map.clear();
    this.total = 0;
  }
}
