#!/usr/bin/env node
// Writes the assetlinks.json your FreeField WEBSITE must serve so that sign-in e-mail links open this app.
//   node scripts/make-assetlinks.mjs                      uses applicationId + signingCertSha256 from company.config.json
//   node scripts/make-assetlinks.mjs --fingerprint AA:BB:..  [--fingerprint ...]   use these certificate fingerprints instead
//   node scripts/make-assetlinks.mjs --out some/file.json    default: signing/assetlinks.json
// Several fingerprints are allowed (for example your own key AND the key a private Google Play listing signs with).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { assetlinksJson, isFingerprint, loadCompanyConfig, ROOT, WEB_ASSETLINKS_PATH } from "./lib/company.mjs";

const argv = process.argv.slice(2);
const values = (flag) => argv.flatMap((a, i) => (a === flag && argv[i + 1] ? [argv[i + 1]] : []));
const cfg = loadCompanyConfig();
const fingerprints = [...new Set([...(values("--fingerprint").map((f) => f.toUpperCase())), ...(values("--fingerprint").length ? [] : [cfg.signingCertSha256].filter(Boolean))])];
const out = resolve(ROOT, values("--out")[0] ?? "signing/assetlinks.json");

if (fingerprints.length === 0) {
  console.error("There is no signing key fingerprint yet. Run `node scripts/make-signing-key.mjs` first (it writes the fingerprint into company.config.json), or pass --fingerprint AA:BB:...");
  process.exit(1);
}
const wrong = fingerprints.filter((f) => !isFingerprint(f));
if (wrong.length) {
  console.error(`Not a SHA-256 fingerprint (expected 32 pairs of hex digits separated by colons): ${wrong.join(", ")}`);
  process.exit(1);
}
if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(cfg.applicationId)) {
  console.error(`applicationId "${cfg.applicationId}" in company.config.json is not valid.`);
  process.exit(1);
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, assetlinksJson(cfg.applicationId, fingerprints));
console.log(`Wrote ${out}`);
console.log(`App id: ${cfg.applicationId}`);
for (const f of fingerprints) console.log(`SHA-256 fingerprint: ${f}`);
console.log(`\nNext: copy that file into your FreeField web repository as\n  ${WEB_ASSETLINKS_PATH}\nand deploy the website again. Then check https://${cfg.authLinkDomain}/.well-known/assetlinks.json in a browser.`);
