/**
 * One identity per signed-in session. Every writer (task creator, timeline entries, comments, markups) and the notification
 * own-edit check take the actor from `useRoster().actor`, which is normalised here:
 * - demo build: the demo persona of the seed (the roster's first person), whatever the demo role's email is;
 * - real sign-in: the profile display name, falling back to the email, then the uid.
 * Never read `user.email` for a stamp directly: it is the fallback, not the identity.
 */
export const DEMO_ACTOR_NAME = "Alex Rivera";

export interface ActorInput {
  demo: boolean;
  uid: string | null | undefined;
  email: string | null | undefined;
  /** the name the shared hook resolved (profile display name in cloud mode) */
  hookName: string | null | undefined;
}

export function resolveActor(i: ActorInput): { uid: string; name: string } {
  const uid = i.uid ?? "";
  if (i.demo) return { uid, name: DEMO_ACTOR_NAME };
  const hook = (i.hookName ?? "").trim();
  // the shared hook falls back to the literal "me" while nothing else is known
  const name = (hook && hook !== "me" ? hook : "") || i.email?.trim() || uid || "me";
  return { uid, name };
}
