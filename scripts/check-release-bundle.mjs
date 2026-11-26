// Verifies that test hooks (`window.__ffm*`) exist only in e2e builds.
//   1. release build (no VITE_FFM_TEST_HOOKS): no `__ffm` identifier may appear in dist
//   2. e2e build (VITE_FFM_TEST_HOOKS=true): the hooks MUST appear (keeps check 1 from passing vacuously)
// Run it under the shared lock: `flock /tmp/ffm-heavy.lock pnpm check:release` (two vite builds).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const app = join(root, "apps/mobile");


export function hookNames(text) {
  return [...new Set(text.match(/__ffm[A-Za-z0-9_]*/g) ?? [])];
}

/** Build-machine fingerprints that must not ship: absolute paths, the user name, source-map references. */
export function leakNames(text, user = process.env.USER ?? "") {
  const hits = new Set();
  // `/home/web_user` is the Emscripten build home baked into third-party wasm loaders (pdf.js, openjpeg), not ours.
  for (const m of text.matchAll(/\/(?:home|Users)\/[A-Za-z0-9_.-]+/g)) if (m[0] !== "/home/web_user") hits.add(`path ${m[0]}`);
  if (user.length > 2 && new RegExp(`\\b${user}\\b`).test(text)) hits.add(`user name ${user}`);
  return [...hits];
}

function* walkAll(dir) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) yield* walkAll(p);
    else yield p;
  }
}

function* walk(dir) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(js|mjs|html|css)$/.test(f)) yield p;
  }
}

function build(outDir, env) {
  execFileSync("node", ["scripts/prepare-assets.mjs"], { cwd: app, stdio: ["ignore", "ignore", "inherit"] });
  execFileSync("pnpm", ["exec", "vite", "build", "--outDir", outDir, "--emptyOutDir"], {
    cwd: app,
    stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env, VITE_FF_DEMO_AUTH: "true", ...env },
  });
  const found = new Set();
  for (const f of walkAll(outDir)) {
    if (f.endsWith(".map")) found.add(`__sourcemap_file:${f.split("/").pop()}`);
  }
  for (const f of walk(outDir)) for (const n of leakNames(readFileSync(f, "utf8"))) found.add(`__leak:${n} in ${f.split("/").pop()}`);
  for (const f of walk(outDir)) for (const n of hookNames(readFileSync(f, "utf8"))) found.add(n);
  return found;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const tmp = mkdtempSync(join(tmpdir(), "ffm-rel-"));
  try {
    delete process.env.VITE_FFM_TEST_HOOKS;
    const release = build(join(tmp, "release"), { VITE_FFM_TEST_HOOKS: "" });
    const e2e = build(join(tmp, "e2e"), { VITE_FFM_TEST_HOOKS: "true" });
    const leaked = [...release];
    console.log("release hooks:", [...release].join(", ") || "(none)");
    console.log("e2e hooks:    ", [...e2e].join(", ") || "(none)");
    let bad = false;
    if (leaked.length) {
      console.error(`FAIL: the release bundle contains test hooks or build-machine traces: ${leaked.join(", ")}`);
      bad = true;
    }
    for (const must of ["__ffmPlans", "__ffmTest", "__ffmModel", "__ffmModelDebug", "__ffmBgGuard"]) {
      if (!e2e.has(must)) {
        console.error(`FAIL: ${must} missing from the e2e bundle (the check would be vacuous)`);
        bad = true;
      }
    }
    if (bad) process.exit(1);
    console.log("release bundle is free of test hooks; e2e bundle has them");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
