// Builds the app with sourcemaps into a temp dir and verifies that every
// singleton package appears in the bundle with exactly ONE resolved copy
// (a second copy breaks hooks, Dexie live queries, Firebase components, three's
// instanceof checks...). Exit code 1 on any duplicate.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const app = join(root, "apps/mobile");
const SINGLETONS = [
  "react", "react-dom", "react-router-dom", "react-router", "dexie", "dexie-react-hooks",
  "firebase", "@firebase/app", "@firebase/auth", "@firebase/firestore", "@firebase/functions", "@firebase/storage",
  "@firebase/util", "@firebase/component", "zod", "zustand", "three", "web-ifc", "scheduler",
  "@thatopen/components", "@thatopen/components-front", "@thatopen/fragments",
];

const out = mkdtempSync(join(tmpdir(), "ffm-single-"));
try {
  const report = join(out, "modules.json");
  execFileSync("pnpm", ["exec", "vite", "build", "--outDir", join(out, "dist"), "--emptyOutDir"], {
    cwd: app,
    stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env, VITE_FF_DEMO_AUTH: "true", FFM_MODULE_REPORT: report },
  });
  const copies = new Map(); // pkg -> Set(resolved dir)
  for (const id of JSON.parse(readFileSync(report, "utf8"))) {
    const m = id.match(/node_modules\/\.pnpm\/([^/]+)\/node_modules\/((?:@[^/]+\/)?[^/]+)\//);
    if (!m) continue;
    const [, dir, pkg] = m;
    if (!copies.has(pkg)) copies.set(pkg, new Set());
    copies.get(pkg).add(dir);
  }
  let bad = 0;
  for (const pkg of SINGLETONS) {
    const set = copies.get(pkg);
    const status = !set ? "absent" : set.size === 1 ? "ok" : "DUPLICATE";
    if (status === "DUPLICATE") bad++;
    console.log(`${status.padEnd(9)} ${pkg}${set ? "  " + [...set].join(" | ") : ""}`);
  }
  if (bad) {
    console.error(`\n${bad} singleton(s) bundled more than once`);
    process.exit(1);
  }
  console.log("\nall singletons resolve to a single copy");
} finally {
  rmSync(out, { recursive: true, force: true });
}
