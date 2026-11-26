/**
 * A screen with unsaved work (the markup editor) can take the hardware Back press before the app navigates: it registers a
 * guard that returns true when it handled the press (for example by asking to discard). One guard at a time; the newest wins.
 */
type Guard = () => boolean;
let guard: Guard | null = null;

export function setBackGuard(g: Guard | null): () => void {
  guard = g;
  return () => {
    if (guard === g) guard = null;
  };
}

/** True when a guard handled the press. */
export function runBackGuard(): boolean {
  try {
    return guard ? guard() : false;
  } catch {
    return false;
  }
}
