import type { User } from "firebase/auth";

/** Firestore / Functions calls used after a link sign-in (injected for tests). */
export interface PostSignInDeps {
  /** Read whether `users/{uid}` exists. */
  profileExists(uid: string): Promise<boolean>;
  /** Merge-write `users/{uid}`. */
  writeProfile(uid: string, data: Record<string, unknown>): Promise<void>;
  redeemInvitation(inviteId: string): Promise<void>;
  refreshClaims(): Promise<unknown>;
}

export interface PostSignInResult {
  profileWritten: boolean;
  redeemError: string | null;
}

/**
 * Same steps as the web finish-sign-in page: own-profile doc (rules pin the
 * email to the token), optional invitation redemption, then a claims refresh.
 * Every step is best-effort offline-tolerant: a failure never signs the user out.
 */
export async function runPostSignIn(user: User, inviteId: string | null, deps: PostSignInDeps): Promise<PostSignInResult> {
  let profileWritten = false;
  if (user.email) {
    try {
      const exists = await deps.profileExists(user.uid);
      const base = { uid: user.uid, email: user.email };
      await deps.writeProfile(user.uid, exists ? base : { ...base, createdAt: Date.now() });
      profileWritten = true;
    } catch (err) {
      console.warn("[auth] profile write failed", err);
    }
  }
  let redeemError: string | null = null;
  if (inviteId) {
    try {
      await deps.redeemInvitation(inviteId);
    } catch (err) {
      redeemError = err instanceof Error ? err.message : String(err);
    }
  }
  try {
    await deps.refreshClaims();
  } catch {
    /* best effort */
  }
  return { profileWritten, redeemError };
}
