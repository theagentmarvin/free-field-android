/**
 * Touch routing for the annotation canvas: ONE finger draws, TWO fingers pan and zoom. A mouse or a pen draws with its single
 * pointer. Pure state machine (no DOM), so the split is unit-tested.
 *
 *   idle --down--> draw --move--> draw --up--> idle                      (draw-start / draw-move / draw-end)
 *   draw --down(2nd)--> nav                                              (draw-cancel: nothing is committed)
 *   nav --move--> nav (pan, and zoom while two pointers are down)        (nav events, incremental)
 *   nav --all up--> idle                                                 (a gesture that began as a pinch never draws)
 */
export type GestureEvent =
  | { type: "draw-start"; x: number; y: number }
  | { type: "draw-move"; x: number; y: number }
  | { type: "draw-end"; x: number; y: number }
  | { type: "draw-cancel" }
  /** Scale by `scale` about (cx, cy), then translate by (dx, dy). */
  | { type: "nav"; dx: number; dy: number; scale: number; cx: number; cy: number };

interface P {
  x: number;
  y: number;
}

export class EditorGesture {
  private ptrs = new Map<number, P>();
  private drawId: number | null = null;
  private nav = false;
  private last: P | null = null;

  get drawing(): boolean {
    return this.drawId !== null;
  }
  get navigating(): boolean {
    return this.nav;
  }
  get pointerCount(): number {
    return this.ptrs.size;
  }

  down(id: number, x: number, y: number): GestureEvent[] {
    this.ptrs.set(id, { x, y });
    if (this.ptrs.size === 1 && !this.nav) {
      this.drawId = id;
      this.last = { x, y };
      return [{ type: "draw-start", x, y }];
    }
    const was = this.drawId !== null;
    this.drawId = null;
    this.last = null;
    this.nav = true;
    return was ? [{ type: "draw-cancel" }] : [];
  }

  move(id: number, x: number, y: number): GestureEvent[] {
    const prev = this.ptrs.get(id);
    if (!prev) return [];
    if (this.drawId === id) {
      this.ptrs.set(id, { x, y });
      this.last = { x, y };
      return [{ type: "draw-move", x, y }];
    }
    if (!this.nav) return [];
    const before = [...this.ptrs.values()].map((p) => ({ ...p }));
    this.ptrs.set(id, { x, y });
    const after = [...this.ptrs.values()];
    if (after.length >= 2) {
      const [a0, b0] = before;
      const [a1, b1] = after;
      const c0 = { x: (a0.x + b0.x) / 2, y: (a0.y + b0.y) / 2 };
      const c1 = { x: (a1.x + b1.x) / 2, y: (a1.y + b1.y) / 2 };
      const d0 = Math.hypot(b0.x - a0.x, b0.y - a0.y);
      const d1 = Math.hypot(b1.x - a1.x, b1.y - a1.y);
      const scale = d0 > 1 && d1 > 1 ? d1 / d0 : 1;
      return [{ type: "nav", dx: c1.x - c0.x, dy: c1.y - c0.y, scale, cx: c0.x, cy: c0.y }];
    }
    return [{ type: "nav", dx: x - prev.x, dy: y - prev.y, scale: 1, cx: prev.x, cy: prev.y }];
  }

  up(id: number, cancelled = false): GestureEvent[] {
    if (!this.ptrs.delete(id)) return [];
    const was = this.drawId === id;
    const at = this.last;
    if (was) {
      this.drawId = null;
      this.last = null;
    }
    if (this.ptrs.size === 0) this.nav = false;
    if (!was || !at) return [];
    return cancelled ? [{ type: "draw-cancel" }] : [{ type: "draw-end", x: at.x, y: at.y }];
  }

  reset(): void {
    this.ptrs.clear();
    this.drawId = null;
    this.nav = false;
    this.last = null;
  }
}
