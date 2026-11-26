// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useThrottledValue } from "./useThrottledValue";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("useThrottledValue", () => {
  it("passes values through when ms is 0", () => {
    const { result, rerender } = renderHook(({ v }) => useThrottledValue(v, 0), { initialProps: { v: 1 } });
    rerender({ v: 2 });
    expect(result.current).toBe(2);
  });

  it("shows the first change at once, coalesces a burst and ends on the newest value", () => {
    vi.setSystemTime(10_000);
    const { result, rerender } = renderHook(({ v }) => useThrottledValue(v, 1000), { initialProps: { v: 0 } });
    rerender({ v: 1 });
    expect(result.current).toBe(1); // leading edge
    for (let i = 2; i <= 50; i++) {
      vi.advanceTimersByTime(10);
      rerender({ v: i });
    }
    expect(result.current).toBe(1); // still inside the window
    act(() => void vi.advanceTimersByTime(1000));
    expect(result.current).toBe(50); // one trailing update, newest value
  });
});
