import {
  isSignInWithEmailLink,
  sendSignInLinkToEmail,
  signInWithEmailLink,
  type ActionCodeSettings,
  type Auth,
  type User,
} from "firebase/auth";
import { ANDROID_PACKAGE, continueUrl, EMAIL_STORAGE_KEY } from "./config";

/** Minimal Storage surface (localStorage in the app, a Map in tests). */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Firebase calls, injectable so the flow is unit-testable without a backend. */
export interface EmailLinkApi {
  isLink(auth: Auth, url: string): boolean;
  send(auth: Auth, email: string, settings: ActionCodeSettings): Promise<void>;
  signIn(auth: Auth, email: string, url: string): Promise<{ user: User }>;
}

export const firebaseEmailLinkApi: EmailLinkApi = {
  isLink: isSignInWithEmailLink,
  send: sendSignInLinkToEmail,
  signIn: signInWithEmailLink,
};

export function actionCodeSettings(url: string = continueUrl()): ActionCodeSettings {
  return {
    url,
    handleCodeInApp: true,
    android: { packageName: ANDROID_PACKAGE, installApp: false },
  };
}

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function isPlausibleEmail(raw: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw.trim());
}

/** Send the sign-in link and remember the address for the completion step. */
export async function requestSignInLink(
  auth: Auth,
  rawEmail: string,
  store: KeyValueStore,
  api: EmailLinkApi = firebaseEmailLinkApi,
  settings: ActionCodeSettings = actionCodeSettings(),
): Promise<string> {
  if (!isPlausibleEmail(rawEmail)) throw new Error("Enter a valid email address.");
  const email = normalizeEmail(rawEmail);
  await api.send(auth, email, settings);
  store.setItem(EMAIL_STORAGE_KEY, email);
  return email;
}

export type CompleteResult =
  | { status: "ignored" }
  | { status: "needs-email" }
  | { status: "signed-in"; user: User; inviteId: string | null }
  | { status: "error"; message: string };

/** Pull `inviteId` out of the continue URL carried inside an action link. */
export function inviteIdFromLink(url: string): string | null {
  try {
    const u = new URL(url);
    const direct = u.searchParams.get("inviteId");
    if (direct) return direct;
    const cont = u.searchParams.get("continueUrl");
    return cont ? new URL(cont).searchParams.get("inviteId") : null;
  } catch {
    return null;
  }
}

/**
 * Complete a sign-in from a link delivered by the OS (App Link / launch URL).
 * `emailOverride` is used when the stored address is gone (cleared data) and
 * the user typed it in. The stored email is removed only on success.
 */
export async function completeSignInFromLink(
  auth: Auth,
  url: string,
  store: KeyValueStore,
  emailOverride?: string,
  api: EmailLinkApi = firebaseEmailLinkApi,
): Promise<CompleteResult> {
  if (!api.isLink(auth, url)) return { status: "ignored" };
  const email = emailOverride ? normalizeEmail(emailOverride) : store.getItem(EMAIL_STORAGE_KEY);
  if (!email) return { status: "needs-email" };
  try {
    const cred = await api.signIn(auth, email, url);
    store.removeItem(EMAIL_STORAGE_KEY);
    return { status: "signed-in", user: cred.user, inviteId: inviteIdFromLink(url) };
  } catch (err) {
    return { status: "error", message: err instanceof Error ? err.message : String(err) };
  }
}
