// Copies the pre-processed demo assets out of the vendored monorepo into
// public/. Mobile NEVER parses IFC (SPEC A5b): the sample model is an
// already-built .frag fragment file captured by the web app's demo seed.
import { copyFileSync, mkdirSync, existsSync, cpSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const app = resolve(here, "..");

// Company (real Firebase) builds ship no demo data: FFM_SKIP_DEMO_ASSETS=true (set by scripts/ci-build-android.sh)
// removes any demo assets left from earlier dev builds and copies only the pdf.js runtime files.
if (process.env.FFM_SKIP_DEMO_ASSETS === "true") {
  rmSync(resolve(app, "public/samples"), { recursive: true, force: true });
  rmSync(resolve(app, "public/seed"), { recursive: true, force: true });
  mkdirSync(resolve(app, "public/samples"), { recursive: true });
  writeFileSync(resolve(app, "public/samples/models.json"), "[]");
  copyPdfjsRuntime();
  console.log("prepare-assets: demo assets skipped (company build)");
  process.exit(0);
}

// Demo data: the maintainer data set of the web repository when it is present (private development), else the
// small app-owned seed in apps/mobile/demo-seed (always present in the public repository). FFM_FORCE_APP_SEED=1 picks
// the app-owned seed even when the web seed exists (used to verify the public setup).
const webSeed = resolve(app, "../../vendor/free-field/apps/settings/public/seed");
const appSeed = resolve(app, "demo-seed");
const useAppSeed = process.env.FFM_FORCE_APP_SEED === "1" || !existsSync(`${webSeed}/manifest.json`);
const seed = useAppSeed ? appSeed : webSeed;
if (!existsSync(`${seed}/manifest.json`)) {
  console.error(
    `prepare-assets: no demo seed found (looked for ${seed}/manifest.json).\n` +
      "  The app-owned seed ships with this repository in apps/mobile/demo-seed; restore it with `git checkout -- apps/mobile/demo-seed`,\n" +
      "  or rebuild it with `node apps/mobile/scripts/build-demo-seed.mjs <path to the web repository's sample.ifc>`.",
  );
  process.exit(1);
}
console.log(`prepare-assets: demo seed = ${useAppSeed ? "app-owned (apps/mobile/demo-seed)" : "web demo seed (vendor/free-field)"}`);

const copies = [[`${seed}/manifest.json`, "public/seed/manifest.json"]];
const manifest = JSON.parse(readFileSync(`${seed}/manifest.json`, "utf8"));

// Every model of the demo building (the latest version of each IFC file, as its pre-built .frag), so the demo shows
// the same federation as the web (structural + MEP + architectural). FFM_DEMO_MODELS (comma-separated name
// prefixes, e.g. "STRUCTURAL") narrows it: the e2e build keeps the small structural model its assertions are built on.
// (The model-name filter only applies to the web seed; the app-owned seed has one model.)
const only = useAppSeed ? [] : (process.env.FFM_DEMO_MODELS ?? "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
const files = new Map((manifest.tables?.ifcFiles ?? []).map((f) => [f.id, f]));
const models = [];
for (const v of manifest.tables?.ifcVersions ?? []) {
  const f = files.get(v.ifcFileId);
  if (!f || !v.isLatest || !v.fragBlobKey) continue;
  const name = f.name.replace(/\.ifc$/i, "");
  if (only.length && !only.some((p) => name.toUpperCase().startsWith(p))) continue;
  const from = `${seed}/blobs/fragBlobs/${v.fragBlobKey}`;
  models.push({ fileId: f.id, name, versionId: v.id, versionNumber: v.versionNumber, fragBlobKey: v.fragBlobKey, asset: `/samples/frags/${v.fragBlobKey}.frag`, size: existsSync(from) ? statSync(from).size : 0 });
  copies.push([from, `public/samples/frags/${v.fragBlobKey}.frag`]);
}
// Smallest first: the light model shows up while the big ones are still loading.
models.sort((a, b) => a.size - b.size);
// Stale files from a build with a different selection must not ship.
rmSync(resolve(app, "public/samples/frags"), { recursive: true, force: true });
rmSync(resolve(app, "public/samples/structural.frag"), { force: true });

// Every plan PDF the demo seed lists (every version), keyed by PdfVersionRecord.blobKey. Read from the manifest so a
// plan added to the web demo (e.g. a new sheet or revision) is never listed without its file ("Render failed").
for (const v of manifest.tables?.pdfVersions ?? []) {
  if (v.blobKey) copies.push([`${seed}/blobs/pdfBlobs/${v.blobKey}`, `public/samples/plans/${v.blobKey}.pdf`]);
}

for (const [from, to] of copies) {
  const dest = resolve(app, to);
  if (!existsSync(from)) {
    console.error(`prepare-assets: missing ${from} (the demo seed is incomplete: run \`git submodule update --init\`, or set FFM_FORCE_APP_SEED=1 to use the app-owned seed)`);
    process.exit(1);
  }
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(from, dest);
  console.log(`prepare-assets: ${to}`);
}

writeFileSync(resolve(app, "public/samples/models.json"), JSON.stringify(models, null, 1));
console.log(`prepare-assets: public/samples/models.json (${models.map((m) => m.name).join(", ")})`);

copyPdfjsRuntime();

// pdf.js runtime assets (fonts for non-embedded text, CJK cmaps, image-decoder wasm), served locally: no CDN.
function copyPdfjsRuntime() {
  const pdfjsRoot = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
  for (const dir of ["standard_fonts", "cmaps", "wasm"]) {
    cpSync(resolve(pdfjsRoot, dir), resolve(app, "public/pdfjs", dir), { recursive: true });
  }
  console.log("prepare-assets: public/pdfjs/{standard_fonts,cmaps,wasm}");
}
