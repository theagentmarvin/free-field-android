import { useEffect, useRef, useState } from "react";

/**
 * `value`, but updated at most once per `ms` (leading edge immediately, then one trailing update with the newest value).
 * `ms <= 0` passes the value through untouched.
 *
 * PERF-1: while a queue drains, every outbox transition and every server snapshot changes the task list inputs. With thousands
 * of tasks each recompute costs hundreds of milliseconds on a tablet, so the list is allowed to lag by `ms` instead of keeping
 * the main thread busy for the whole drain.
 */
export function useThrottledValue<T>(value: T, ms: number): T {
  const [shown, setShown] = useState(value);
  const last = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(value);
  latest.current = value;

  useEffect(() => {
    if (ms <= 0) {
      setShown(value);
      return;
    }
    if (Object.is(value, shown)) return;
    const wait = last.current + ms - Date.now();
    if (wait <= 0) {
      last.current = Date.now();
      setShown(value);
      return;
    }
    if (timer.current === null) {
      timer.current = setTimeout(() => {
        timer.current = null;
        last.current = Date.now();
        setShown(latest.current);
      }, wait);
    }
  }, [value, ms, shown]);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  return ms <= 0 ? value : shown;
}

/** Lists up to this many tasks update immediately; larger ones are throttled while the inputs keep changing. */
export const LARGE_LIST = 500;
export const LARGE_LIST_THROTTLE_MS = 1000;
