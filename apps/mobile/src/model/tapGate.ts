/**
 * One decision per tap gesture. The viewer's own click pick is switched off (`builtInClickPick={false}`: its GPU passes
 * held the main thread for 3.5 to 14 s per tap and could select hidden elements), so a tap is decided by the
 * visibility-aware fragments raycast alone (tens of ms). The token drops the result of a tap that a newer tap superseded
 * while its raycast was in flight.
 */
export type TapOutcome = "select" | "clear" | "stale";

export class TapGate {
  private token = 0;

  /** A tap started (pointer up on the stage). Returns its token. */
  begin(): number {
    return ++this.token;
  }

  /** Measure mode took over: every tap still in flight is stale (it must not select anything when its raycast returns). */
  invalidate(): void {
    this.token++;
  }

  /** The raycast of tap `token` finished. `hit`: it found an element. */
  settle(token: number, hit: boolean): TapOutcome {
    if (token !== this.token) return "stale";
    return hit ? "select" : "clear";
  }
}
