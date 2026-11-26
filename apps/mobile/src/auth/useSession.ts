import { isDemoAuth, useAuth } from "@ff/auth";
import { useSignedIn } from "../session";

export type SessionStatus = "loading" | "signed-out" | "signed-in";

export interface Session {
  status: SessionStatus;
  uid: string | null;
  email: string | null;
  demo: boolean;
}

/**
 * One gate for the whole app. Cloud mode: the Firebase user (persisted in
 * IndexedDB, so it resolves offline). Demo mode: the sign-in screen's flag.
 */
export function useSession(): Session {
  const demo = isDemoAuth();
  const demoSignedIn = useSignedIn();
  const { user, loading } = useAuth();
  if (demo) {
    return { status: demoSignedIn ? "signed-in" : "signed-out", uid: user?.uid ?? null, email: user?.email ?? null, demo };
  }
  if (loading) return { status: "loading", uid: null, email: null, demo };
  return user
    ? { status: "signed-in", uid: user.uid, email: user.email, demo }
    : { status: "signed-out", uid: null, email: null, demo };
}
