import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync, writeFileSync } from "node:fs";
import { effectiveDomain, loadCompanyConfig, validateCompanyConfig, validateFirebaseEnv } from "../../scripts/lib/company.mjs";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

// Singletons that MUST (only direct dependencies of this app can be listed:
// dedupe resolves from the app root, so the transitive @firebase/* packages are
// covered through `firebase` and verified by scripts/check-singletons.mjs).
// Singletons that MUST resolve to exactly one copy across the app and the
// vendored @ff/* sources (see scripts/check-singletons.mjs).
const SINGLETONS = [
  "react",
  "react-dom",
  "react-router-dom",
  "dexie",
  "dexie-react-hooks",
  "firebase",
  "zod",
  "zustand",
  "three",
  "@thatopen/components",
  "@thatopen/components-front",
  "@thatopen/fragments",
  "web-ifc",
];

/**
 * Company settings (company.config.json at the repo root) baked into the bundle. A real build (not the demo, not the
 * emulator lane) refuses to continue without a sign-in domain: it never falls back to someone else's website.
 * FFM_COMPANY_BUILD=true (set by scripts/ci-build-android.sh) additionally rejects the example placeholders and
 * checks the Firebase web settings.
 */
function companySettings(command: string) {
  const env = process.env;
  const company = loadCompanyConfig();
  const demo = env.VITE_FF_DEMO_AUTH === "true";
  const emulator = env.VITE_FIREBASE_USE_EMULATOR === "true";
  const strict = env.FFM_COMPANY_BUILD === "true";
  if (command === "build" && !demo && !emulator) {
    const problems = validateCompanyConfig(company, { strict, env }).map((p) => `${p.key}: ${p.message}`);
    if (strict) problems.push(...validateFirebaseEnv(env));
    if (problems.length > 0) {
      throw new Error(`\nThe app cannot be built yet:\n - ${problems.join("\n - ")}\nSee docs/company/INSTALL.md.\n`);
    }
  }
  return { applicationId: company.applicationId, authLinkDomain: effectiveDomain(company, env) };
}

export default defineConfig(({ command }) => ({
  plugins: [
    react(),
    // scripts/check-singletons.mjs: dump the ids of every module that made it
    // into the bundle (far cheaper than sourcemaps).
    ...(process.env.FFM_MODULE_REPORT
      ? [
          {
            name: "ffm-module-report",
            generateBundle(_options, bundle) {
              const ids = new Set<string>();
              for (const item of Object.values(bundle)) {
                if (item.type === "chunk") for (const id of Object.keys(item.modules)) ids.add(id);
              }
              writeFileSync(process.env.FFM_MODULE_REPORT!, JSON.stringify([...ids]));
            },
          } satisfies Plugin,
        ]
      : []),
  ],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __FF_COMPANY__: JSON.stringify(companySettings(command)),
  },
  resolve: { dedupe: SINGLETONS },
  // The tile worker (plans/pdfWorker.ts) is an ES module worker: it imports pdf.js.
  worker: { format: "es" },
  // @thatopen/fragments ships its own Web Worker: never pre-bundle it.
  optimizeDeps: { exclude: ["@thatopen/fragments"] },
  build: {
    target: "es2022",
    sourcemap: false,
    chunkSizeWarningLimit: 4000,
  },
  server: { host: true, port: 5174 },
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
  },
}));
