/**
 * One-finger intent classifier for 3D measuring. The finger is a camera control first and a pen second:
 *
 *   - a TAP (short press, little movement) places a point where the finger is;
 *   - a one-finger DRAG orbits the camera and never places anything;
 *   - a LONG PRESS (the finger rests for `holdMs`) starts a precise aim: the reticle sits `aimOffset` px ABOVE the fingertip,
 *     the finger slides to move it, and lifting places the point at the reticle;
 *   - a second finger at any time abandons whatever was going on and belongs to pan/zoom.
 *
 *   idle --down--> pending --move>slop--> orbit --up--> idle
 *   pending --hold--> aim --move--> aim --up--> idle (place at the reticle)
 *   pending --up--> idle (place at the finger: a tap)
 *   pending|aim|orbit --down(2nd)--> multi (cancel when aiming) --all up--> idle
 *
 * Pure: the caller owns the hold timer (call `hold()` when it fires) and the pointer plumbing. `swallowMoves` tells the
 * caller whether the camera controls must NOT see the pointer moves right now (a tap or an aim must not nudge the view).
 */
export type TouchPhase = "idle" | "pending" | "orbit" | "aim" | "multi";

export type TouchIntentEvent =
  | { type: "aim"; x: number; y: number; fx: number; fy: number }
  | { type: "place"; x: number; y: number }
  | { type: "cancel" };

export const TAP_SLOP_PX = 10;
/** Android's standard long-press timeout: a slightly slow tap is still a tap. */
export const HOLD_MS = 500;
export const AIM_OFFSET_PX = 60;

export interface TouchIntentOptions {
  slop?: number;
  /** Where the reticle goes for a finger at (x, y); default: `aimOffset` above it. */
  reticle?: (x: number, y: number) => { x: number; y: number };
}

/** The reticle for a finger: `offset` px above it, kept inside `rect` (client pixels, with a margin so the ring stays visible). */
export function reticleFor(x: number, y: number, rect: { left: number; top: number; right: number; bottom: number }, offset = AIM_OFFSET_PX, margin = 8): { x: number; y: number } {
  return {
    x: Math.max(rect.left + margin, Math.min(rect.right - margin, x)),
    y: Math.max(rect.top + margin, Math.min(rect.bottom - margin, y - offset)),
  };
}

export class TouchIntent {
  private ptrs = new Map<number, { x: number; y: number }>();
  private id: number | null = null;
  private start = { x: 0, y: 0 };
  private last = { x: 0, y: 0 };
  private _phase: TouchPhase = "idle";
  private readonly slop: number;
  private readonly reticle: (x: number, y: number) => { x: number; y: number };

  constructor(opts: TouchIntentOptions = {}) {
    this.slop = opts.slop ?? TAP_SLOP_PX;
    this.reticle = opts.reticle ?? ((x, y) => ({ x, y: y - AIM_OFFSET_PX }));
  }

  get phase(): TouchPhase {
    return this._phase;
  }

  /** The camera controls must not receive the pointer moves (a pending tap or an aim). */
  get swallowMoves(): boolean {
    return this._phase === "pending" || this._phase === "aim";
  }

  /** The hold timer should be running (a finger rests and may turn into an aim). */
  get holdArmed(): boolean {
    return this._phase === "pending";
  }

  private aimEvent(): TouchIntentEvent {
    const r = this.reticle(this.last.x, this.last.y);
    return { type: "aim", x: r.x, y: r.y, fx: this.last.x, fy: this.last.y };
  }

  down(id: number, x: number, y: number): TouchIntentEvent[] {
    this.ptrs.set(id, { x, y });
    if (this.ptrs.size === 1 && this._phase === "idle") {
      this.id = id;
      this.start = { x, y };
      this.last = { x, y };
      this._phase = "pending";
      return [];
    }
    const wasAim = this._phase === "aim";
    this.id = null;
    this._phase = "multi";
    return wasAim ? [{ type: "cancel" }] : [];
  }

  move(id: number, x: number, y: number): TouchIntentEvent[] {
    if (!this.ptrs.has(id)) return [];
    this.ptrs.set(id, { x, y });
    if (id !== this.id) return [];
    this.last = { x, y };
    if (this._phase === "pending" && Math.hypot(x - this.start.x, y - this.start.y) > this.slop) this._phase = "orbit";
    return this._phase === "aim" ? [this.aimEvent()] : [];
  }

  /** The hold timer fired: a finger that rested becomes an aim. */
  hold(): TouchIntentEvent[] {
    if (this._phase !== "pending") return [];
    this._phase = "aim";
    return [this.aimEvent()];
  }

  up(id: number, cancelled = false): TouchIntentEvent[] {
    if (!this.ptrs.delete(id)) return [];
    const mine = id === this.id;
    const phase = this._phase;
    if (this.ptrs.size === 0) {
      this._phase = "idle";
      this.id = null;
    } else if (mine) {
      this.id = null;
    }
    if (!mine) return [];
    if (phase === "aim") {
      if (cancelled) return [{ type: "cancel" }];
      const r = this.reticle(this.last.x, this.last.y);
      return [{ type: "place", x: r.x, y: r.y }];
    }
    if (phase === "pending" && !cancelled) return [{ type: "place", x: this.last.x, y: this.last.y }];
    return [];
  }
}
