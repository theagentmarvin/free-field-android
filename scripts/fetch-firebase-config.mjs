#!/usr/bin/env node
/**
 * fetch-firebase-config.mjs - writes apps/mobile/.env.production (the Firebase WEB config, public values) so you
 * do not have to copy them by hand.
 *
 *   node scripts/fetch-firebase-config.mjs --project <firebase-project-id> [--app-id <web app id>]
 *       asks the Firebase CLI (`firebase apps:list WEB` and `apps:sdkconfig`). If you are not signed in, run
 *       `npx firebase-tools login` first (a browser opens; you sign in with the company Google account and click Allow).
 *   node scripts/fetch-firebase-config.mjs --from <path to the web app's .env.production>
 *       copies the VITE_FIREBASE_* lines from the file you used to deploy the website.
 *   --force  overwrite an existing apps/mobile/.env.production
 * It prints the names it wrote, never the values.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FIREBASE_WEB_VARS, readProperties, ROOT } from "./lib/company.mjs";

const argv = process.argv.slice(2);
const opt = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);
const target = join(ROOT, "apps", "mobile", ".env.production");
const WIN = process.platform === "win32";
const fail = (m) => {
  console.error(`\n${m}\n`);
  process.exit(1);
};
if (existsSync(target) && !argv.includes("--force")) fail("apps/mobile/.env.production already exists. Add --force to replace it.");

let values = {};
if (opt("--from")) {
  const src = readProperties(opt("--from"));
  for (const k of FIREBASE_WEB_VARS) if (src[k]) values[k] = src[k];
  if (!values.VITE_EXPECTED_FIREBASE_PROJECT_ID && values.VITE_FIREBASE_PROJECT_ID) values.VITE_EXPECTED_FIREBASE_PROJECT_ID = values.VITE_FIREBASE_PROJECT_ID;
} else {
  const project = opt("--project");
  if (!project) fail("Tell me the Firebase project: --project <project-id>   (or use --from <web .env.production>).");
  const fb = (args) => {
    const direct = spawnSync("firebase", args, { encoding: "utf8", shell: WIN });
    if (!direct.error) return direct;
    return spawnSync("npx", ["--yes", "firebase-tools", ...args], { encoding: "utf8", shell: WIN });
  };
  let appId = opt("--app-id");
  if (!appId) {
    const r = fb(["apps:list", "WEB", "--project", project, "--json"]);
    if (r.status !== 0) fail(`The Firebase CLI could not list the web apps of ${project}. Are you signed in? Run: npx firebase-tools login\n${(r.stderr || r.stdout || "").trim().split("\n").slice(-3).join("\n")}`);
    let apps = [];
    try {
      apps = JSON.parse(r.stdout).result ?? [];
    } catch {
      /* fall through */
    }
    if (apps.length === 0) fail(`Project ${project} has no web app. The FreeField website needs one: it is created by the website deploy (docs/deploy/self-hosting.md).`);
    if (apps.length > 1) fail(`Several web apps exist in ${project}; pick one with --app-id:\n${apps.map((a) => `  ${a.appId}  ${a.displayName ?? ""}`).join("\n")}`);
    appId = apps[0].appId;
  }
  const r = fb(["apps:sdkconfig", "WEB", appId, "--project", project]);
  if (r.status !== 0) fail(`Could not read the web config: ${(r.stderr || r.stdout || "").trim().split("\n").slice(-2).join(" ")}`);
  const text = r.stdout;
  const get = (k) => new RegExp(`["']?${k}["']?\\s*:\\s*["']([^"']+)["']`).exec(text)?.[1];
  const map = { apiKey: "VITE_FIREBASE_API_KEY", authDomain: "VITE_FIREBASE_AUTH_DOMAIN", projectId: "VITE_FIREBASE_PROJECT_ID", storageBucket: "VITE_FIREBASE_STORAGE_BUCKET", messagingSenderId: "VITE_FIREBASE_MESSAGING_SENDER_ID", appId: "VITE_FIREBASE_APP_ID" };
  for (const [k, name] of Object.entries(map)) if (get(k)) values[name] = get(k);
  values.VITE_EXPECTED_FIREBASE_PROJECT_ID = values.VITE_FIREBASE_PROJECT_ID;
}
const missing = FIREBASE_WEB_VARS.filter((k) => !values[k]);
if (missing.length) fail(`Could not find: ${missing.join(", ")}. Fill them in by hand (apps/mobile/.env.example).`);
writeFileSync(target, "# Firebase web config (public values). Written by scripts/fetch-firebase-config.mjs. Git-ignored.\n" + FIREBASE_WEB_VARS.map((k) => `${k}=${values[k]}`).join("\n") + "\n");
console.log(`Wrote ${target}\nSet: ${FIREBASE_WEB_VARS.join(", ")}`);
