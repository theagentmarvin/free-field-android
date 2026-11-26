/**
 * Long-press detection for list rows (pointer events, so touch and mouse both work). The press fires after `ms` without moving
 * more than `slop` pixels; the click that follows a fired press must be swallowed by the caller (`consumeClick`).
 */
export interface LongPress {
  onPointerDown(e: { clientX: number; clientY: number; button?: number }): void;
  onPointerMove(e: { clientX: number; clientY: number }): void;
  cancel(): void;
  /** true once after a long press fired: the click that follows it should do nothing */
  consumeClick(): boolean;
}

export function createLongPress(onLong: () => void, ms = 480, slop = 10, timers: { set(f: () => void, ms: number): ReturnType<typeof setTimeout>; clear(t: ReturnType<typeof setTimeout>): void } = {
    // arrow wrappers: a browser's setTimeout throws "Illegal invocation" when called as a method of another object
    set: (f, ms) => setTimeout(f, ms),
    clear: (t) => clearTimeout(t),
  },
): LongPress {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let start: { x: number; y: number } | null = null;
  let fired = false;
  const cancel = (): void => {
    if (timer !== null) timers.clear(timer);
    timer = null;
    start = null;
  };
  return {
    onPointerDown(e) {
      if (e.button !== undefined && e.button > 0) return;
      cancel();
      fired = false;
      start = { x: e.clientX, y: e.clientY };
      timer = timers.set(() => {
        timer = null;
        fired = true;
        onLong();
      }, ms);
    },
    onPointerMove(e) {
      if (!start) return;
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > slop) cancel();
    },
    cancel,
    consumeClick() {
      const f = fired;
      fired = false;
      return f;
    },
  };
}
