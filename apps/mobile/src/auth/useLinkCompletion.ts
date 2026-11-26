import { useCallback } from "react";
import { doc, getDoc, getFirestore, setDoc } from "firebase/firestore";
import { getFunctions, httpsCallable } from "firebase/functions";
import { useAuthContext } from "@ff/auth";
import { completeSignInFromLink } from "./emailLink";
import { useLinkStore } from "./linkStore";
import { runPostSignIn } from "./postSignIn";

/** `complete(url, email?)`: finish an e-mail link sign-in and run the post-sign-in steps. */
export function useLinkCompletion(): (url: string, emailOverride?: string) => Promise<void> {
  const { app, auth, refreshClaims } = useAuthContext();
  return useCallback(
    async (url, emailOverride) => {
      const store = useLinkStore.getState();
      store.setError(null);
      store.setCompleting(true);
      try {
        const result = await completeSignInFromLink(auth, url, window.localStorage, emailOverride);
        if (result.status === "needs-email") {
          store.setPending(url);
        } else if (result.status === "error") {
          store.setError(result.message);
        } else if (result.status === "signed-in") {
          store.setPending(null);
          const db = getFirestore(app);
          const fns = getFunctions(app);
          const post = await runPostSignIn(result.user, result.inviteId, {
            profileExists: async (uid) => (await getDoc(doc(db, "users", uid))).exists(),
            writeProfile: (uid, data) => setDoc(doc(db, "users", uid), data, { merge: true }),
            redeemInvitation: async (inviteId) => {
              await httpsCallable(fns, "redeemInvitation")({ inviteId });
            },
            refreshClaims,
          });
          if (post.redeemError) store.setError(`Signed in, but the invitation was not accepted: ${post.redeemError}`);
        }
      } finally {
        store.setCompleting(false);
      }
    },
    [app, auth, refreshClaims],
  );
}
