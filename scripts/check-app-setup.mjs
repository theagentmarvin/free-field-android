#!/usr/bin/env node
/**
 * check-app-setup.mjs - readiness check for building and installing your company's FreeField field app.
 *
 * Dependency-free (Node 20+). It only READS: your files, (with --github) `gh` listings of NAMES, and, unless --offline,
 * your website's assetlinks.json. It never prints a secret or a variable value, only their names.
 *
 *   node scripts/check-app-setup.mjs               check everything
 *   node scripts/check-app-setup.mjs --offline     skip the website check
 *   node scripts/check-app-setup.mjs --github      also check the GitHub repository's variables and secrets (optional workflow)
 *   node scripts/check-app-setup.mjs --ascii       plain [OK]/[FAIL] marks for old Windows consoles
 *   node scripts/check-app-setup.mjs --repo owner/name   GitHub repository to inspect (default: this folder's)
 *
 * Exit code 1 when at least one blocker was found.
 */
import { spawnSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  findToolchain,
  readProperties,
  SIGNING_PROPS_FILE,
  validateFirebaseEnv,
  FIREBASE_WEB_VARS,
  SIGNING_SECRETS,
  isFingerprint,
  loadCompanyConfig,
  ROOT,
  validateCompanyConfig,
  WEB_ASSETLINKS_PATH,
} from "./lib/company.mjs";

const argv = process.argv.slice(2);
const OFFLINE = argv.includes("--offline");
const ASCII = argv.includes("--ascii") || process.env.NO_EMOJI === "1";
const ICON = ASCII ? { ok: "[OK]  ", warn: "[WARN]", fail: "[FAIL]", info: "[INFO]" } : { ok: "✅", warn: "⚠️ ", fail: "❌", info: "ℹ️ " };

const results = [];
let section = "";
const add = (level, label, detail = "", fix = "") => results.push({ section, level, label, detail, fix });
const run = (cmd, args, extra = {}) => spawnSync(cmd, args, { encoding: "utf8", cwd: ROOT, timeout: 20000, shell: process.platform === "win32", ...extra });

// ------------------------------------------------------------------ settings file
section = "Your settings (company.config.json)";
let cfg;
try {
  cfg = loadCompanyConfig();
} catch (e) {
  add("fail", "company.config.json could not be read", e.message, "Restore the file from the original template and edit the values again.");
}
if (cfg) {
  const problems = validateCompanyConfig(cfg, { strict: true });
  if (problems.length === 0) {
    add("ok", `${cfg.appName}, id ${cfg.applicationId}, version ${cfg.versionName} (code ${cfg.versionCode}), website ${cfg.authLinkDomain}`);
  }
  for (const p of problems) add("fail", `${p.key} needs your attention`, "", p.message);
}

// ------------------------------------------------------------------ repository
section = "This copy of the code";
if (existsSync(join(ROOT, "vendor/free-field/packages/ff-auth/package.json"))) add("ok", "FreeField web code (vendor/free-field) is present");
else add("fail", "FreeField web code (vendor/free-field) is missing", "The app is built from it.", "Run: git submodule update --init   (GitHub's own build does this by itself, but a copy made with a plain download misses it. Make the copy with \"Use this template\" or \"Import\", see docs/company/INSTALL.md.)");

// ------------------------------------------------------------------ this computer
section = "Build on this computer";
const tc = findToolchain();
const WINDOWS = process.platform === "win32";
const javaOk = tc.javaHome && existsSync(join(tc.javaHome, "bin", WINDOWS ? "keytool.exe" : "keytool"));
const sdkOk = tc.androidHome && existsSync(join(tc.androidHome, "build-tools", "35.0.0")) && existsSync(join(tc.androidHome, "platforms", "android-35"));
if (javaOk && sdkOk) add("ok", "Java and the Android SDK are installed", `${tc.javaHome}`);
else add("fail", "Java 21 and/or the Android SDK are missing", "", "Run: node scripts/setup-android-toolchain.mjs --accept-licenses   (installs them for your user only; --check just reports)");
const envFile = join(ROOT, "apps", "mobile", ".env.production");
if (!existsSync(envFile)) add("fail", "apps/mobile/.env.production (Firebase web settings) does not exist", "", "Run: node scripts/fetch-firebase-config.mjs --project <firebase-project-id>   (or copy apps/mobile/.env.example and fill it in)");
else {
  const e = readProperties(envFile);
  const issues = validateFirebaseEnv(e);
  if (issues.length === 0) add("ok", "Firebase web settings are filled in", FIREBASE_WEB_VARS.join(", "));
  else for (const i of issues) add("fail", "Firebase web settings need attention", "", i.replace(/Add them in GitHub:.*$/, "Edit apps/mobile/.env.production."));
}
if (!existsSync(SIGNING_PROPS_FILE)) add("fail", "No signing key on this computer (signing.local.properties)", "", "Run once: node scripts/make-signing-key.mjs   (then back the key up in your password manager)");
else {
  const p = readProperties(SIGNING_PROPS_FILE);
  const ks = p.storeFile ? resolve(ROOT, p.storeFile) : "";
  if (!ks || !existsSync(ks)) add("fail", "The key file named in signing.local.properties does not exist", "", "Restore it from your password manager backup.");
  else if (!javaOk) add("info", "Key file present; cannot open it until Java is installed");
  else {
    const r = run(join(tc.javaHome, "bin", WINDOWS ? "keytool.exe" : "keytool"), ["-exportcert", "-rfc", "-alias", p.keyAlias, "-keystore", ks, "-storepass:env", "FF_KEY_PW"], { env: { ...process.env, FF_KEY_PW: p.storePassword }, shell: false });
    if (r.status !== 0) add("fail", "The signing key cannot be opened with the password in signing.local.properties", "", "Compare with your password manager backup.");
    else {
      const fpNow = new X509Certificate(r.stdout).fingerprint256;
      if (!cfg?.signingCertSha256) add("warn", "company.config.json has no signingCertSha256", "", `Add this fingerprint: ${fpNow}`);
      else if (fpNow !== cfg.signingCertSha256) add("fail", "The key file does NOT match signingCertSha256 in company.config.json", "", "Use the original key. Never replace the key once tablets use the app.");
      else add("ok", "The signing key opens and matches the recorded fingerprint");
    }
  }
}

// ------------------------------------------------------------------ GitHub (optional workflow)
section = "GitHub (optional workflow)";
const WANT_GH = argv.includes("--github");
const ghVersion = WANT_GH ? run("gh", ["--version"]) : { error: true, skip: true };
let repo = null;
let ghReady = false;
if (ghVersion.skip) {
  /* not requested */
} else if (ghVersion.error || ghVersion.status !== 0) {
  add("warn", "The GitHub CLI (gh) is not installed", "Needed only by this checker and by the key helper to look at / store the secrets.", "Install it from https://cli.github.com, then run: gh auth login   (or check the lists by hand in GitHub > Settings > Secrets and variables > Actions)");
} else if (run("gh", ["auth", "status"]).status !== 0) {
  add("warn", "You are not signed in to GitHub in this terminal", "", "Run: gh auth login   (a browser window opens; you sign in and click Authorize)");
} else {
  ghReady = true;
  const i = argv.indexOf("--repo");
  repo = i >= 0 ? argv[i + 1] : run("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]).stdout.trim();
  if (!repo) add("warn", "Could not tell which GitHub repository this folder belongs to", "", "Is this a clone of your company's copy? Or pass --repo owner/name");
  else add("ok", `Signed in to GitHub; repository ${repo}`);
}
const names = (kind) => {
  const r = run("gh", [kind, "list", "--repo", repo, "--json", "name", "-q", ".[].name"]);
  return r.status === 0 ? new Set(r.stdout.split(/\r?\n/).filter(Boolean)) : null;
};
if (ghReady && repo) {
  const secrets = names("secret");
  if (!secrets) add("warn", "Could not list the repository secrets", "You may lack permission on this repository.", "Ask the repository owner, or check Settings > Secrets and variables > Actions by hand.");
  else {
    const missing = SIGNING_SECRETS.filter((n) => !secrets.has(n));
    if (missing.length === 0) add("ok", "The four signing secrets are stored", SIGNING_SECRETS.join(", "));
    else add("fail", `Signing secrets missing: ${missing.join(", ")}`, "", "Run once: node scripts/make-signing-key.mjs   (creates the key and stores the secrets)");
  }
  const vars = names("variable");
  if (!vars) add("warn", "Could not list the repository variables", "", "Check Settings > Secrets and variables > Actions > Variables by hand.");
  else {
    const missing = FIREBASE_WEB_VARS.filter((n) => !vars.has(n));
    if (missing.length === 0) add("ok", "The Firebase variables are set", FIREBASE_WEB_VARS.join(", "));
    else add("fail", `Firebase variables missing: ${missing.join(", ")}`, "", "Add each one under Settings > Secrets and variables > Actions > Variables (values come from the Firebase web app config; see docs/company/INSTALL.md).");
  }
}

// ------------------------------------------------------------------ key and assetlinks
section = "Website link file (assetlinks.json)";
const fp = String(cfg?.signingCertSha256 ?? "");
if (!fp) add("fail", "No signing key fingerprint in company.config.json yet", "", "Run once: node scripts/make-signing-key.mjs");
else if (!isFingerprint(fp)) add("fail", "signingCertSha256 in company.config.json is not a valid fingerprint", "", "Run node scripts/make-signing-key.mjs, or paste the SHA-256 fingerprint of your key (32 hex pairs with colons).");
else add("ok", `Key fingerprint recorded: ${fp}`);

if (!OFFLINE && cfg && isFingerprint(fp) && cfg.authLinkDomain) {
  const url = `https://${cfg.authLinkDomain}/.well-known/assetlinks.json`;
  const fix = `Put signing/assetlinks.json in your web repository as ${WEB_ASSETLINKS_PATH} and deploy the website (docs/company/INSTALL.md, part 4). Without it, sign-in links open the website instead of the app.`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000), redirect: "follow" });
    const type = res.headers.get("content-type") ?? "";
    if (!res.ok) add("warn", `${url} answers ${res.status}`, "The website does not publish the link file yet.", fix);
    else {
      let list = null;
      try {
        list = JSON.parse(await res.text());
      } catch {
        /* not JSON: the site answers every address with its home page */
      }
      const targets = Array.isArray(list) ? list.map((e) => e?.target).filter(Boolean) : [];
      const mine = targets.filter((t) => t.package_name === cfg.applicationId);
      if (!list) add("warn", `${url} does not return JSON (it looks like the home page)`, "", fix);
      else if (mine.length === 0) add("fail", `The website's assetlinks.json does not list ${cfg.applicationId}`, "", fix);
      else if (!mine.some((t) => (t.sha256_cert_fingerprints ?? []).map((x) => String(x).toUpperCase()).includes(fp))) add("fail", "The website's assetlinks.json has a different key fingerprint than your key", "", fix);
      else if (!/json/i.test(type)) add("warn", `assetlinks.json is correct but served as "${type}"`, "Android wants application/json.", "Add the header rule from docs/company/INSTALL.md (part 4) to the web firebase.json.");
      else add("ok", "The website publishes assetlinks.json with your app id and key");
    }
  } catch (e) {
    add("warn", `Could not reach ${url}`, String(e.cause?.code ?? e.message), "Check the website address in company.config.json, or run again when online (--offline skips this).");
  }
}

// ------------------------------------------------------------------ report
const order = ["Your settings (company.config.json)", "This copy of the code", "Build on this computer", "GitHub (optional workflow)", "Website link file (assetlinks.json)"];
console.log(`\nFreeField field app setup check${OFFLINE ? " [offline]" : ""}\n`);
for (const s of order) {
  const rows = results.filter((r) => r.section === s);
  if (!rows.length) continue;
  console.log(s);
  for (const r of rows) {
    console.log(`  ${ICON[r.level]} ${r.label}${r.detail ? `  - ${r.detail}` : ""}`);
    if (r.fix && r.level !== "ok") console.log(`       fix: ${r.fix}`);
  }
  console.log("");
}
const fails = results.filter((r) => r.level === "fail").length;
const warns = results.filter((r) => r.level === "warn").length;
console.log(`Summary: ${fails} blocker(s), ${warns} warning(s).`);
if (!fails) console.log("Next: node scripts/build-android.mjs   (docs/company/INSTALL.md, part 6).");
process.exit(fails ? 1 : 0);
