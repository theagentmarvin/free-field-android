import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLongPress } from "./longPress";

describe("long press", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const at = (x = 100, y = 100) => ({ clientX: x, clientY: y });

  it("fires after the hold time and swallows the click that follows", () => {
    const fn = vi.fn();
    const lp = createLongPress(fn, 480);
    lp.onPointerDown(at());
    vi.advanceTimersByTime(479);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(lp.consumeClick()).toBe(true);
    expect(lp.consumeClick()).toBe(false);
  });
  it("a short tap does nothing and its click goes through", () => {
    const fn = vi.fn();
    const lp = createLongPress(fn);
    lp.onPointerDown(at());
    vi.advanceTimersByTime(100);
    lp.cancel();
    vi.advanceTimersByTime(1000);
    expect(fn).not.toHaveBeenCalled();
    expect(lp.consumeClick()).toBe(false);
  });
  it("scrolling (moving past the slop) cancels the press", () => {
    const fn = vi.fn();
    const lp = createLongPress(fn, 480, 10);
    lp.onPointerDown(at(100, 100));
    lp.onPointerMove(at(104, 103));
    vi.advanceTimersByTime(300);
    lp.onPointerMove(at(100, 130));
    vi.advanceTimersByTime(1000);
    expect(fn).not.toHaveBeenCalled();
  });
  it("ignores secondary buttons", () => {
    const fn = vi.fn();
    const lp = createLongPress(fn);
    lp.onPointerDown({ ...at(), button: 2 });
    vi.advanceTimersByTime(1000);
    expect(fn).not.toHaveBeenCalled();
  });
});
