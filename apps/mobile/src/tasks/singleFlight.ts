import { useCallback, useRef } from "react";

/**
 * Runs `fn` unless a previous call is still in flight. A double tap (or a tap on the
 * soft keyboard's Send followed by the button) must not enqueue the same action twice:
 * React state alone is too slow, the second click event arrives before the re-render.
 */
export function singleFlight<A extends unknown[]>(fn: (...args: A) => Promise<void>): (...args: A) => Promise<void> {
  let busy = false;
  return async (...args: A) => {
    if (busy) return;
    busy = true;
    try {
      await fn(...args);
    } finally {
      busy = false;
    }
  };
}

/** Hook form: `const once = useSingleFlight(); onClick={() => void once(async () => {...})}`. */
export function useSingleFlight(): (fn: () => Promise<void>) => Promise<void> {
  const busy = useRef(false);
  return useCallback(async (fn) => {
    if (busy.current) return;
    busy.current = true;
    try {
      await fn();
    } finally {
      busy.current = false;
    }
  }, []);
}
