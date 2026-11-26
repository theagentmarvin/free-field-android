/**
 * Build-time auth configuration (Vite env). Kept in one place so the sign-in
 * screen, the link handler and the e2e tooling agree on the same values.
 */

/** Path the continue URL points at (App Links intent filter matches it). */
export const FINISH_SIGN_IN_PATH = "/finish-sign-in";
/** Same localStorage key the web app uses for the pending sign-in email. */
export const EMAIL_STORAGE_KEY = "emailForSignIn";

/** Company settings baked in at build time from company.config.json (see vite.config.ts). */
declare const __FF_COMPANY__: { applicationId: string; authLinkDomain: string } | undefined;
const company = typeof __FF_COMPANY__ === "undefined" ? undefined : __FF_COMPANY__;

/** The Android application id of this build (company.config.json). */
export const ANDROID_PACKAGE: string = company?.applicationId ?? "";

type Env = Record<string, string | undefined>;

function viteEnv(): Env {
  return (import.meta as unknown as { env?: Env }).env ?? {};
}

const cleanDomain = (raw: string | undefined) => (raw ?? "").trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");

/**
 * The company's FreeField website host: VITE_FF_AUTH_LINK_DOMAIN, else company.config.json. There is no built-in
 * default: with nothing configured this throws (a build never points at somebody else's site).
 */
export function authLinkDomain(env: Env = viteEnv(), configured: string | undefined = company?.authLinkDomain): string {
  const domain = cleanDomain(env.VITE_FF_AUTH_LINK_DOMAIN) || cleanDomain(configured);
  if (!domain) throw new Error("No sign-in link domain: set authLinkDomain in company.config.json (docs/company/INSTALL.md).");
  return domain;
}

/** The continue URL handed to Firebase; the e-mailed link comes back through it. */
export function continueUrl(env: Env = viteEnv(), configured?: string): string {
  return `https://${authLinkDomain(env, configured ?? company?.authLinkDomain)}${FINISH_SIGN_IN_PATH}`;
}

export function usesEmulator(env: Env = viteEnv()): boolean {
  return env.VITE_FIREBASE_USE_EMULATOR === "true";
}

/** Emulator host (adb reverse makes `localhost` reach the dev machine). */
export function emulatorHost(env: Env = viteEnv()): string {
  return (env.VITE_FIREBASE_EMULATOR_HOST ?? "").trim() || "localhost";
}
