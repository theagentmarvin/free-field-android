import { useSyncExternalStore } from "react";

/**
 * Demo-mode session gate for the sign-in screen. In demo mode the auth
 * provider is always "signed in"; this flag only decides whether the user has
 * pressed through the sign-in screen. Cloud mode uses the Firebase user (see auth/useSession).
 */
const KEY = "ffm-session";
const listeners = new Set<() => void>();

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

let current = read();

export function signInSession(): void {
  current = true;
  try {
    localStorage.setItem(KEY, "1");
  } catch {
    /* storage blocked: session lasts for this page load only */
  }
  listeners.forEach((l) => l());
}

export function signOutSession(): void {
  current = false;
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l());
}

export function useSignedIn(): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
    () => current,
  );
}
