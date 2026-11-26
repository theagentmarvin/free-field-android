/**
 * One-finger point placement that coexists with two-finger pan/zoom. The finger AIMS (a loupe follows it) and the point is
 * placed on release; a second finger at any time abandons the aim and hands the gesture to pan/zoom, and a gesture that
 * began as a pinch never places anything, even when it ends on one finger.
 *
 *   idle --down(1st)--> aiming --move--> aiming --up--> idle (place)
 *   aiming --down(2nd)--> multi (cancel) --all up--> idle
 *   aiming --cancel--> idle (cancel)
 */
export type PlacementEvent =
  | { type: "aim"; x: number; y: number }
  | { type: "place"; x: number; y: number }
  | { type: "cancel" };

export class PlacementGesture {
  private ptrs = new Map<number, { x: number; y: number }>();
  private aimId: number | null = null;
  private multi = false;
  private last: { x: number; y: number } | null = null;

  get aiming(): boolean {
    return this.aimId !== null;
  }

  /** The pointer count is two or more (pan/zoom territory). */
  get panning(): boolean {
    return this.multi;
  }

  down(id: number, x: number, y: number): PlacementEvent[] {
    this.ptrs.set(id, { x, y });
    if (this.ptrs.size === 1 && !this.multi) {
      this.aimId = id;
      this.last = { x, y };
      return [{ type: "aim", x, y }];
    }
    // A second finger: whatever was aimed is abandoned and the whole gesture belongs to pan/zoom.
    const was = this.aimId !== null;
    this.aimId = null;
    this.last = null;
    this.multi = true;
    return was ? [{ type: "cancel" }] : [];
  }

  move(id: number, x: number, y: number): PlacementEvent[] {
    if (!this.ptrs.has(id)) return [];
    this.ptrs.set(id, { x, y });
    if (this.aimId !== id) return [];
    this.last = { x, y };
    return [{ type: "aim", x, y }];
  }

  up(id: number, cancelled = false): PlacementEvent[] {
    if (!this.ptrs.delete(id)) return [];
    const wasAim = this.aimId === id;
    const at = this.last;
    if (wasAim) {
      this.aimId = null;
      this.last = null;
    }
    if (this.ptrs.size === 0) this.multi = false;
    if (!wasAim || !at) return [];
    return cancelled ? [{ type: "cancel" }] : [{ type: "place", x: at.x, y: at.y }];
  }
}
