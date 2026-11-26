#!/usr/bin/env node
/**
 * build-android.mjs - builds your company's signed Android app (works on Windows, macOS and Linux).
 *
 *   node scripts/build-android.mjs            signed .apk  ->  release/<AppName>-<version>.apk
 *   node scripts/build-android.mjs --aab      also an Android App Bundle (.aab) for a private Google Play listing
 *   node scripts/build-android.mjs --skip-install   do not run `pnpm install` first
 *
 * It needs (and tells you in plain words if something is missing):
 *   - company.config.json filled in (app name, application id, version, website address)
 *   - apps/mobile/.env.production with the Firebase web settings (node scripts/fetch-firebase-config.mjs fills it)
 *   - the signing key: signing.local.properties (made by scripts/make-signing-key.mjs), OR the environment variables
 *     ANDROID_KEYSTORE_PATH (or ANDROID_KEYSTORE_BASE64), ANDROID_KEYSTORE_PASSWORD, ANDROID_KEY_ALIAS, ANDROID_KEY_PASSWORD
 *   - Java 21 and the Android SDK (node scripts/setup-android-toolchain.mjs installs them for your user)
 * Passwords are read from files/environment and never printed. The same script is used by the optional GitHub workflow.
 */
import { spawnSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import {
  findToolchain,
  loadCompanyConfig,
  missingSigningSecrets,
  readProperties,
  ROOT,
  SIGNING_PROPS_FILE,
  validateCompanyConfig,
  validateFirebaseEnv,
} from "./lib/company.mjs";

const argv = process.argv.slice(2);
const AAB = argv.includes("--aab") || process.env.FFM_BUILD_AAB === "true";
const SKIP_INSTALL = argv.includes("--skip-install") || process.env.FFM_SKIP_INSTALL === "1";
const WIN = process.platform === "win32";
const MOBILE = join(ROOT, "apps", "mobile");
const ENV_FILE = join(MOBILE, ".env.production");

const step = (m) => console.log(`\n== ${m}`);
function stop(problems) {
  const list = Array.isArray(problems) ? problems : [problems];
  console.error(`\nThe app cannot be built yet. Please fix:\n${list.map((p) => ` - ${p}`).join("\n")}\n\nStep-by-step guide: docs/company/INSTALL.md`);
  process.exit(1);
}
const q = (a) => (/[\s"&|<>^()]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
/** Runs a command, streaming its output. On Windows .cmd/.bat shims need a shell. */
function run(cmd, args, { cwd = ROOT, env = process.env, capture = false } = {}) {
  const r = WIN ? spawnSync([cmd, ...args].map(q).join(" "), { cwd, env, shell: true, encoding: "utf8", stdio: capture ? "pipe" : "inherit" }) : spawnSync(cmd, args, { cwd, env, encoding: "utf8", stdio: capture ? "pipe" : "inherit" });
  return r;
}
function mustRun(label, cmd, args, opts) {
  const r = run(cmd, args, opts);
  if (r.status !== 0) {
    console.error(`\nSTOP: "${label}" failed (see the messages above).`);
    process.exit(1);
  }
  return r;
}

// ---- 1. settings -------------------------------------------------------------------------------------------------
step("Checking your settings");
const cfg = loadCompanyConfig();
const problems = validateCompanyConfig(cfg, { strict: true }).map((p) => `company.config.json, ${p.key}: ${p.message}`);

// Firebase web settings: the environment first, then apps/mobile/.env.production (the same VITE_* names the web uses).
const env = { ...process.env };
if (existsSync(ENV_FILE)) {
  for (const [k, v] of Object.entries(readProperties(ENV_FILE))) if (!env[k]) env[k] = v.replace(/^(['"])(.*)\1$/, "$2");
} else if (!env.VITE_FIREBASE_PROJECT_ID) {
  problems.push("apps/mobile/.env.production does not exist. Create it with: node scripts/fetch-firebase-config.mjs   (or copy apps/mobile/.env.example and fill it in).");
}
problems.push(...validateFirebaseEnv(env));

// ---- 2. signing key -----------------------------------------------------------------------------------------------
let tmpDir = null;
const cleanup = () => tmpDir && rmSync(tmpDir, { recursive: true, force: true });
process.on("exit", cleanup);
let sign = null;
if (!missingSigningSecrets(env).length) {
  let ks = env.ANDROID_KEYSTORE_PATH;
  if (!ks) {
    tmpDir = mkdtempSync(join(tmpdir(), "ff-ks-"));
    ks = join(tmpDir, "release.p12");
    writeFileSync(ks, Buffer.from(env.ANDROID_KEYSTORE_BASE64, "base64"));
  }
  sign = { file: resolve(ROOT, ks), storePassword: env.ANDROID_KEYSTORE_PASSWORD, keyAlias: env.ANDROID_KEY_ALIAS, keyPassword: env.ANDROID_KEY_PASSWORD };
} else if (existsSync(SIGNING_PROPS_FILE)) {
  const p = readProperties(SIGNING_PROPS_FILE);
  const missing = ["storeFile", "storePassword", "keyAlias", "keyPassword"].filter((k) => !p[k]);
  if (missing.length) problems.push(`signing.local.properties is missing: ${missing.join(", ")}.`);
  else sign = { file: resolve(ROOT, p.storeFile), storePassword: p.storePassword, keyAlias: p.keyAlias, keyPassword: p.keyPassword };
} else {
  problems.push("There is no signing key yet. Create it once with: node scripts/make-signing-key.mjs   (and back it up in your password manager). Without your own key the app could not be updated on tablets later, so the build stops here on purpose.");
}
if (sign && !existsSync(sign.file)) problems.push(`The key file ${sign.file} does not exist. Restore it from your password manager backup.`);

// ---- 3. toolchain ------------------------------------------------------------------------------------------------
const tc = findToolchain();
const javaBin = (name) => (tc.javaHome ? join(tc.javaHome, "bin", WIN ? `${name}.exe` : name) : null);
if (!tc.javaHome || !existsSync(javaBin("keytool"))) problems.push("Java 21 was not found. Run: node scripts/setup-android-toolchain.mjs --accept-licenses");
if (!tc.androidHome || !existsSync(join(tc.androidHome, "platforms", "android-35"))) problems.push("The Android SDK was not found. Run: node scripts/setup-android-toolchain.mjs --accept-licenses");
if (!existsSync(join(ROOT, "vendor/free-field/packages/ff-auth/package.json"))) problems.push("The FreeField web code (vendor/free-field) is missing. Run: git submodule update --init");
if (problems.length) stop(problems);

// The key must be readable and be the one the website was told about.
let keyFp = "";
{
  const kenv = { ...process.env, FF_KEY_PW: sign.storePassword };
  const r = spawnSync(javaBin("keytool"), ["-exportcert", "-rfc", "-alias", sign.keyAlias, "-keystore", sign.file, "-storetype", "PKCS12", "-storepass:env", "FF_KEY_PW"], { encoding: "utf8", env: kenv });
  if (r.status !== 0) stop("The signing key could not be opened: the password or the alias is wrong, or the file is damaged. Check signing.local.properties against your password manager backup.");
  keyFp = new X509Certificate(r.stdout).fingerprint256;
}
console.log(`Signing key fingerprint (SHA-256): ${keyFp}`);
if (cfg.signingCertSha256 && cfg.signingCertSha256 !== keyFp) {
  stop("This key is not the one named in company.config.json (signingCertSha256). Sign-in links would not open the app and tablets would refuse the update. Use the original key. Only if no tablet runs the app yet may you update signingCertSha256 and the website's assetlinks.json.");
}

// ---- 4. build ----------------------------------------------------------------------------------------------------
const buildEnv = {
  ...env,
  JAVA_HOME: tc.javaHome,
  ANDROID_HOME: tc.androidHome,
  ANDROID_SDK_ROOT: tc.androidHome,
  PATH: [join(tc.javaHome, "bin"), join(tc.androidHome, "platform-tools"), env.PATH ?? env.Path ?? ""].join(delimiter),
  FFM_COMPANY_BUILD: "true",
  FFM_SKIP_DEMO_ASSETS: "true",
  FFM_KEYSTORE_PATH: sign.file,
  FFM_KEYSTORE_PASSWORD: sign.storePassword,
  FFM_KEY_ALIAS: sign.keyAlias,
  FFM_KEY_PASSWORD: sign.keyPassword,
};
for (const k of ["VITE_FF_DEMO_AUTH", "VITE_FFM_TEST_HOOKS", "VITE_FIREBASE_USE_EMULATOR", "FFM_EMULATOR_BUILD"]) delete buildEnv[k];

if (!SKIP_INSTALL) {
  step("Installing dependencies");
  mustRun("pnpm install", "pnpm", ["install", "--frozen-lockfile"], { env: buildEnv });
}
step("Building the app (cloud mode)");
mustRun("prepare assets", "node", ["scripts/prepare-assets.mjs"], { cwd: MOBILE, env: buildEnv });
mustRun("web build", "pnpm", ["exec", "vite", "build"], { cwd: MOBILE, env: buildEnv });
const dist = join(MOBILE, "dist");
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
const files = walk(dist);
if (files.some((f) => f.endsWith(".frag"))) stop("Demo models were found in the build. This should never happen: stop and report it.");
if (files.filter((f) => f.endsWith(".js")).some((f) => readFileSync(f, "utf8").includes("__ffmTest"))) stop("Test hooks were found in the build. This should never happen: stop and report it.");
mustRun("cap sync", "pnpm", ["exec", "cap", "sync", "android"], { cwd: MOBILE, env: buildEnv });

step("Building the signed Android app (Gradle, the first time downloads a lot: be patient)");
const gradle = WIN ? "gradlew.bat" : "./gradlew";
const tasks = ["assembleRelease", ...(AAB ? ["bundleRelease"] : [])];
const prefix = (process.env.FFM_GRADLE_PREFIX ?? "").split(/\s+/).filter(Boolean);
const [gcmd, ...gpre] = prefix.length ? [...prefix, gradle] : [gradle];
mustRun("gradle", gcmd, [...gpre, "--no-daemon", ...tasks], { cwd: join(MOBILE, "android"), env: buildEnv });

// ---- 5. output and verification -----------------------------------------------------------------------------------
const out = join(ROOT, "release");
mkdirSync(out, { recursive: true });
const base = `${cfg.appName.trim().replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") || "app"}-${cfg.versionName}`;
const apk = join(out, `${base}.apk`);
copyFileSync(join(MOBILE, "android/app/build/outputs/apk/release/app-release.apk"), apk);
if (AAB) copyFileSync(join(MOBILE, "android/app/build/outputs/bundle/release/app-release.aab"), join(out, `${base}.aab`));

step("Verifying the result");
const bt = join(tc.androidHome, "build-tools", "35.0.0");
const signer = run(join(bt, WIN ? "apksigner.bat" : "apksigner"), ["verify", "--print-certs", apk], { capture: true });
const hex = /certificate SHA-256 digest: ([0-9a-f]+)/i.exec(signer.stdout ?? "")?.[1]?.toUpperCase();
const apkFp = hex?.replace(/(..)(?!$)/g, "$1:");
if (signer.status !== 0 || !apkFp) stop("The APK signature could not be verified.");
if (apkFp !== keyFp) stop("The APK is signed with a different certificate than your key.");
const badging = run(join(bt, WIN ? "aapt2.exe" : "aapt2"), ["dump", "badging", apk], { capture: true }).stdout ?? "";
const gotId = /^package: name='([^']*)'/m.exec(badging)?.[1];
const gotLabel = /^application-label:'(.*)'$/m.exec(badging)?.[1];
if (gotId !== cfg.applicationId) stop(`The APK has package id '${gotId}' but company.config.json says '${cfg.applicationId}'.`);
if (gotLabel !== cfg.appName) stop(`The APK is named '${gotLabel}' but company.config.json says '${cfg.appName}'.`);
console.log(`APK is signed. Certificate SHA-256: ${apkFp}`);
console.log(`Package id: ${gotId}    App name: ${gotLabel}    Version: ${cfg.versionName} (${cfg.versionCode})`);
console.log(`\nDone. Your app:\n  ${apk}${AAB ? `\n  ${join(out, `${base}.aab`)}` : ""}\nInstall it on tablets: docs/company/INSTALL.md, part 8.`);
