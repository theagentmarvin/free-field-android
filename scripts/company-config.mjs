#!/usr/bin/env node
// Small command line over company.config.json, for shell scripts and the GitHub workflow.
//   node scripts/company-config.mjs get <key>          print one value (appName, applicationId, versionName, ...)
//   node scripts/company-config.mjs validate [--strict] [--ci]
//        --strict  reject the example placeholders (a real company build)
//        --ci      also check the Firebase web variables and the signing secrets (by name; values are never printed)
// Exit code 1 when something blocks the build, with a plain-language list of what to fix.
import { effectiveDomain, loadCompanyConfig, missingSigningSecrets, validateCompanyConfig, validateFirebaseEnv } from "./lib/company.mjs";

const [cmd, ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter((a) => a.startsWith("--")));
const cfg = loadCompanyConfig();

if (cmd === "get") {
  const key = rest.find((a) => !a.startsWith("--"));
  const value = key === "authLinkDomain" ? effectiveDomain(cfg) : cfg[key];
  if (value === undefined || value === null) {
    console.error(`company.config.json has no "${key}"`);
    process.exit(2);
  }
  console.log(String(value));
} else if (cmd === "validate") {
  const problems = validateCompanyConfig(cfg, { strict: flags.has("--strict") }).map((p) => `company.config.json, ${p.key}: ${p.message}`);
  if (flags.has("--ci")) {
    problems.push(...validateFirebaseEnv());
    const secrets = missingSigningSecrets();
    if (secrets.length > 0) {
      problems.push(
        `The signing key is not set up in this GitHub repository (missing secrets: ${secrets.join(", ")}). ` +
          "Run the key helper once on your computer: node scripts/make-signing-key.mjs. It creates the key and stores the four secrets for you. " +
          "Without your own key the app cannot be installed as an update later, so the build stops here on purpose.",
      );
    }
  }
  if (problems.length > 0) {
    console.error("The app cannot be built yet. Please fix:\n" + problems.map((p) => ` - ${p}`).join("\n"));
    console.error("\nStep-by-step guide: docs/company/INSTALL.md");
    process.exit(1);
  }
  console.log("Company settings look good.");
} else {
  console.error("usage: company-config.mjs get <key> | validate [--strict] [--ci]");
  process.exit(2);
}
