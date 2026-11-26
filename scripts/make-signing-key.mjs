#!/usr/bin/env node
// Creates your company's app signing key (a PKCS12 keystore made with the JDK's keytool), prints its SHA-256
// fingerprint and writes assetlinks.json. Works on Windows, macOS and Linux (run scripts/setup-android-toolchain.mjs first
// if you have no Java; this script finds the JDK it installed).
//
//   node scripts/make-signing-key.mjs                   create the key in ./signing and the passwords file signing.local.properties
//   options: --out <folder> (default: signing)  --alias <name> (default: field-app)
//   optional: --upload-github [--repo owner/name]   also store the four secrets in a GitHub repository (only for the
//             GitHub Actions workflow; needs `gh auth login`)  /  --upload-existing  does that for an existing key
//
// The passwords are random, are written only to signing.local.properties and are NEVER printed.
//
// IMPORTANT: the key can not be replaced later. Every update of the app must be signed with the same key, otherwise
// tablets refuse the update and you would have to uninstall the app, which erases its offline data. Back up the key
// file AND signing.local.properties in your company password manager.
import { spawnSync } from "node:child_process";
import { X509Certificate, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { assetlinksJson, findToolchain, loadCompanyConfig, readProperties, ROOT, SIGNING_PROPS_FILE, setConfigValue, slug } from "./lib/company.mjs";

const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const opt = (f, d) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : d);
const WIN = process.platform === "win32";
const fail = (msg) => {
  console.error(`\n${msg}\n`);
  process.exit(1);
};

const cfg = loadCompanyConfig();
const outDir = resolve(ROOT, opt("--out", "signing"));
const alias = opt("--alias", "field-app");
const keystorePath = join(outDir, `${slug(cfg.applicationId)}.p12`);
const assetlinksPath = join(outDir, "assetlinks.json");
const propsFile = SIGNING_PROPS_FILE;
const show = (p) => (relative(ROOT, p).startsWith("..") || isAbsolute(relative(ROOT, p)) ? p : relative(ROOT, p));

function keytool() {
  const { javaHome } = findToolchain();
  const candidates = [javaHome && join(javaHome, "bin", WIN ? "keytool.exe" : "keytool"), "keytool"].filter(Boolean);
  for (const c of candidates) if (spawnSync(c, ["-help"], { encoding: "utf8" }).error === undefined) return c;
  fail("keytool (part of Java) was not found. Run first: node scripts/setup-android-toolchain.mjs --accept-licenses");
}

// ---- optional GitHub upload (secondary path) ------------------------------------------------------------------
const gh = (args, input) => spawnSync("gh", args, { encoding: "utf8", input, cwd: ROOT, shell: WIN });
function uploadToGithub(ksPath, pw, keyAlias) {
  if (gh(["--version"]).error) fail("The GitHub CLI (gh) is not installed. Get it from https://cli.github.com and run `gh auth login`.");
  if (gh(["auth", "status"]).status !== 0) fail("You are not signed in to GitHub. Run `gh auth login` (a browser opens), then try again.");
  const repo = opt("--repo", undefined) ?? gh(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]).stdout.trim();
  if (!repo) fail("Could not tell which GitHub repository this is. Pass --repo owner/name.");
  const secrets = { ANDROID_KEYSTORE_BASE64: readFileSync(ksPath).toString("base64"), ANDROID_KEYSTORE_PASSWORD: pw, ANDROID_KEY_ALIAS: keyAlias, ANDROID_KEY_PASSWORD: pw };
  for (const [name, value] of Object.entries(secrets)) {
    const r = gh(["secret", "set", name, "--repo", repo], value);
    if (r.status !== 0) fail(`Could not store ${name} in ${repo}: ${(r.stderr || "").trim().split("\n")[0]}`);
    console.log(`  stored secret ${name}`);
  }
  console.log(`GitHub secrets are in place in ${repo}.`);
}

if (flag("--upload-existing")) {
  if (!existsSync(propsFile) || !existsSync(keystorePath)) fail("No earlier key found here.");
  const p = readProperties(propsFile);
  uploadToGithub(keystorePath, p.storePassword, p.keyAlias);
  process.exit(0);
}

if (!/^[A-Za-z0-9_-]{1,40}$/.test(alias)) fail("The alias may only contain letters, numbers, - and _ (up to 40 characters).");
if (existsSync(keystorePath) || existsSync(propsFile)) {
  fail(
    `A signing key already exists (${show(existsSync(keystorePath) ? keystorePath : propsFile)}).\nThis script never replaces it: a new key would make every installed tablet reject updates.\n` +
      "If you really lost it and no tablet uses the app yet, move the old files somewhere else and run this again.",
  );
}

const kt = keytool();
// One random password for the store and the key (a PKCS12 keystore protects both with the same one). Letters, digits, - and _ only.
const password = randomBytes(24).toString("base64url");
const org = (cfg.appName || "FreeField Field").replace(/[^A-Za-z0-9 .-]/g, "").trim() || "FreeField Field";
const env = { ...process.env, FF_KEY_PW: password };
mkdirSync(outDir, { recursive: true });
const gen = spawnSync(
  kt,
  ["-genkeypair", "-alias", alias, "-keyalg", "RSA", "-keysize", "2048", "-validity", "10000", "-storetype", "PKCS12", "-keystore", keystorePath, "-storepass:env", "FF_KEY_PW", "-keypass:env", "FF_KEY_PW", "-dname", `CN=${org}, O=${org}`],
  { encoding: "utf8", env },
);
if (gen.status !== 0) fail(`keytool failed:\n${(gen.stderr || gen.stdout || "").trim()}`);
const exp = spawnSync(kt, ["-exportcert", "-rfc", "-alias", alias, "-keystore", keystorePath, "-storepass:env", "FF_KEY_PW"], { encoding: "utf8", env });
if (exp.status !== 0) fail(`keytool could not read the new key:\n${(exp.stderr || "").trim()}`);
const fingerprint = new X509Certificate(exp.stdout).fingerprint256;
try {
  chmodSync(keystorePath, 0o600);
} catch {
  /* Windows */
}

const storeFileValue = relative(ROOT, keystorePath).startsWith("..") ? keystorePath : relative(ROOT, keystorePath);
writeFileSync(
  propsFile,
  [
    "# KEEP THIS FILE SAFE and secret. Never commit it, never send it by chat or e-mail.",
    "# Back it up, together with the .p12 key file, in your company password manager.",
    "# If this key is lost, tablets that have the app can no longer be updated.",
    `# App id: ${cfg.applicationId}`,
    `# SHA-256 fingerprint: ${fingerprint}`,
    `storeFile=${storeFileValue.replace(/\\/g, "/")}`,
    `storePassword=${password}`,
    `keyAlias=${alias}`,
    `keyPassword=${password}`,
    "",
  ].join("\n"),
);
try {
  chmodSync(propsFile, 0o600);
} catch {
  /* Windows */
}
setConfigValue("signingCertSha256", fingerprint);
writeFileSync(assetlinksPath, assetlinksJson(cfg.applicationId, [fingerprint]));

console.log("The signing key was created.");
console.log(`  Key file:        ${keystorePath}`);
console.log(`  Passwords file:  ${propsFile}   (the passwords are NOT shown here)`);
console.log(`  SHA-256 fingerprint: ${fingerprint}`);
console.log(`  assetlinks.json: ${assetlinksPath}`);
console.log("  The fingerprint was also written into company.config.json (it is public information).");
if (flag("--upload-github")) uploadToGithub(keystorePath, password, alias);
console.log(
  [
    "",
    "!! IMPORTANT !!",
    `  1. Back up ${show(keystorePath)} AND ${show(propsFile)} in your company password manager NOW.`,
    "     If you lose this key, tablets that already have the app can no longer be updated: the app would have to be uninstalled (its offline data is erased) and installed again.",
    "     Never change the key later, never commit these files, never paste the passwords into a chat.",
    `  2. Copy ${show(assetlinksPath)} into your FreeField web repository as apps/settings/public/.well-known/assetlinks.json and deploy the website.`,
    "  3. Then run: node scripts/check-app-setup.mjs",
  ].join("\n"),
);
