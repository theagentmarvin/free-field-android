// Shared reader/validator for company.config.json. Plain Node, no dependencies:
// used by the CI build script, the readiness checker, the key helper, vite.config.ts and the e2e tooling.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const CONFIG_FILE = resolve(ROOT, "company.config.json");
/** Optional, git-ignored developer override (same keys). Lets the maintainers keep their own ids locally. */
export const LOCAL_CONFIG_FILE = resolve(ROOT, "company.config.local.json");

export const FIREBASE_WEB_VARS = [
  "VITE_FIREBASE_API_KEY",
  "VITE_FIREBASE_AUTH_DOMAIN",
  "VITE_FIREBASE_PROJECT_ID",
  "VITE_FIREBASE_STORAGE_BUCKET",
  "VITE_FIREBASE_MESSAGING_SENDER_ID",
  "VITE_FIREBASE_APP_ID",
  "VITE_EXPECTED_FIREBASE_PROJECT_ID",
];
export const SIGNING_SECRETS = [
  "ANDROID_KEYSTORE_BASE64",
  "ANDROID_KEYSTORE_PASSWORD",
  "ANDROID_KEY_ALIAS",
  "ANDROID_KEY_PASSWORD",
];

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

/** company.config.json, with company.config.local.json (if present) laid over it. `FFM_COMPANY_CONFIG` picks another file. */
export function loadCompanyConfig() {
  const base = process.env.FFM_COMPANY_CONFIG ? resolve(process.env.FFM_COMPANY_CONFIG) : CONFIG_FILE;
  if (!existsSync(base)) throw new Error(`company.config.json not found at ${base}`);
  const cfg = { ...readJson(base) };
  if (!process.env.FFM_COMPANY_CONFIG && existsSync(LOCAL_CONFIG_FILE)) Object.assign(cfg, readJson(LOCAL_CONFIG_FILE));
  delete cfg._help;
  return cfg;
}

export const normalizeDomain = (raw) => String(raw ?? "").trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");

/** The sign-in link domain: the VITE_FF_AUTH_LINK_DOMAIN build variable wins over the config file. */
export function effectiveDomain(cfg, env = process.env) {
  return normalizeDomain(env.VITE_FF_AUTH_LINK_DOMAIN) || normalizeDomain(cfg.authLinkDomain);
}

const PACKAGE_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const HOST_RE = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;

export const isPlaceholderPackage = (v) => v === "com.example.field" || /^com\.example\./.test(v ?? "");
export const isPlaceholderDomain = (v) => !v || /(^|\.)example\.(com|org|net)$/i.test(v) || /\.(invalid|test|localhost)$/i.test(v);
export const isPlaceholderName = (v) => !v || /^my company field$/i.test(v.trim());

/**
 * Problems with the company settings. `strict` = a real company build (placeholders are errors); otherwise
 * only malformed values are reported. Returns [{ key, message }].
 */
export function validateCompanyConfig(cfg, { strict = false, env = process.env } = {}) {
  const out = [];
  const bad = (key, message) => out.push({ key, message });
  const name = String(cfg.appName ?? "").trim();
  if (!name) bad("appName", "appName is empty. Write the name that should appear under the app icon on the tablet.");
  else if (name.length > 30) bad("appName", "appName is longer than 30 characters; the tablet would cut it off.");
  else if (/[<>&"'\\]/.test(name)) bad("appName", "appName contains one of < > & \" ' \\ . Please use plain letters, numbers and spaces.");
  else if (strict && isPlaceholderName(name)) bad("appName", "appName is still the example text (\"My Company Field\"). Put your company's name.");

  const id = String(cfg.applicationId ?? "");
  if (!PACKAGE_RE.test(id)) bad("applicationId", `applicationId "${id}" is not valid. Use lowercase letters, numbers and underscores in at least two parts separated by dots, for example com.mycompany.field`);
  else if (strict && isPlaceholderPackage(id)) bad("applicationId", "applicationId is still the example (com.example.field). Use your own, for example com.mycompany.field. Choose it once and never change it later.");

  if (!Number.isInteger(cfg.versionCode) || cfg.versionCode < 1 || cfg.versionCode > 2100000000) bad("versionCode", "versionCode must be a whole number of 1 or more. Raise it by 1 every time you publish a new version.");
  if (!/^\d+(\.\d+){0,3}([-+][0-9A-Za-z.-]+)?$/.test(String(cfg.versionName ?? ""))) bad("versionName", "versionName should look like 1.0.0");

  const domain = effectiveDomain(cfg, env);
  if (!domain) bad("authLinkDomain", "authLinkDomain is empty. Write the address of your company's FreeField website, for example freefield.mycompany.com (no https://).");
  else if (!HOST_RE.test(domain)) bad("authLinkDomain", `authLinkDomain "${domain}" is not a website address. Write only the host, for example freefield.mycompany.com`);
  else if (strict && isPlaceholderDomain(domain)) bad("authLinkDomain", "authLinkDomain is still the example (freefield.example.com). Write your company's FreeField website address.");

  const fp = String(cfg.signingCertSha256 ?? "");
  if (fp && !/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(fp)) bad("signingCertSha256", "signingCertSha256 must be 32 pairs of hex digits separated by colons (the make-signing-key script writes it for you).");
  return out;
}

/** Names (never values) of the Firebase web variables that are missing or obviously fake. */
export function missingFirebaseVars(env = process.env) {
  return FIREBASE_WEB_VARS.filter((k) => !String(env[k] ?? "").trim());
}

/** Problems with the Firebase web config for a cloud build. Messages carry names only. */
export function validateFirebaseEnv(env = process.env) {
  const out = [];
  const missing = missingFirebaseVars(env);
  if (missing.length) out.push(`These Firebase settings are empty: ${missing.join(", ")}. Add them in GitHub: Settings > Secrets and variables > Actions > Variables.`);
  const p = String(env.VITE_FIREBASE_PROJECT_ID ?? "").trim();
  const e = String(env.VITE_EXPECTED_FIREBASE_PROJECT_ID ?? "").trim();
  if (p && e && p !== e) out.push("VITE_EXPECTED_FIREBASE_PROJECT_ID must be exactly the same as VITE_FIREBASE_PROJECT_ID. It protects you from building for the wrong Firebase project.");
  if (String(env.VITE_FIREBASE_USE_EMULATOR ?? "") === "true") out.push("VITE_FIREBASE_USE_EMULATOR is true. A company build must talk to the real Firebase project: remove that variable.");
  if (String(env.VITE_FF_DEMO_AUTH ?? "") === "true") out.push("VITE_FF_DEMO_AUTH is true (demo mode, no sign-in). A company build must not use demo mode: remove that variable.");
  return out;
}

export function missingSigningSecrets(env = process.env) {
  // A keystore file on this computer (ANDROID_KEYSTORE_PATH) can stand in for the base64 secret.
  const haveFile = String(env.ANDROID_KEYSTORE_PATH ?? "").trim() !== "";
  return SIGNING_SECRETS.filter((k) => !(k === "ANDROID_KEYSTORE_BASE64" && haveFile) && !String(env[k] ?? "").trim());
}

export const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "app";

/** Digital Asset Links content for the web site: this app id, trusted with these signing-certificate fingerprints. */
export function assetlinksJson(applicationId, fingerprints) {
  return JSON.stringify(
    [
      {
        relation: ["delegate_permission/common.handle_all_urls"],
        target: { namespace: "android_app", package_name: applicationId, sha256_cert_fingerprints: fingerprints },
      },
    ],
    null,
    2,
  ) + "\n";
}

export const isFingerprint = (v) => /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(String(v));

/** Where the file goes inside the FreeField WEB repository so the web deploy publishes it. */
export const WEB_ASSETLINKS_PATH = "apps/settings/public/.well-known/assetlinks.json";

/** Writes one key into company.config.json, keeping the other lines as they are. */
export function setConfigValue(key, value, file = process.env.FFM_COMPANY_CONFIG ? resolve(process.env.FFM_COMPANY_CONFIG) : CONFIG_FILE) {
  const cfg = readJson(file);
  cfg[key] = value;
  writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
}

/** Folder of the user-local toolchain made by scripts/setup-android-toolchain.mjs. */
export const TOOLCHAIN_DIR = process.env.FFM_TOOLCHAIN_DIR ? resolve(process.env.FFM_TOOLCHAIN_DIR) : resolve(process.env.HOME ?? process.env.USERPROFILE ?? ".", ".freefield-android");

/** { javaHome, androidHome } from toolchain.json, JAVA_HOME / ANDROID_HOME, or null parts when unknown. */
export function findToolchain() {
  let saved = {};
  try {
    saved = JSON.parse(readFileSync(resolve(TOOLCHAIN_DIR, "toolchain.json"), "utf8"));
  } catch {
    /* not installed by our script */
  }
  return {
    javaHome: process.env.FFM_JAVA_HOME || saved.javaHome || process.env.JAVA_HOME || null,
    androidHome: process.env.FFM_ANDROID_HOME || saved.androidHome || process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || null,
  };
}

/** Parses a simple key=value .properties file (comments with # allowed). Values are never logged. */
export function readProperties(file) {
  const out = {};
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

export const SIGNING_PROPS_FILE = process.env.FFM_SIGNING_PROPS ? resolve(process.env.FFM_SIGNING_PROPS) : resolve(ROOT, "signing.local.properties");
