import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Playwright compiles specs to CommonJS, so the shared ESM reader (scripts/lib/company.mjs) cannot be imported here.
// This mirrors its loadCompanyConfig/effectiveDomain: company.config.json, then company.config.local.json on top,
// or the single file named by FFM_COMPANY_CONFIG.
interface Company {
  applicationId: string;
  authLinkDomain: string;
}

export function loadCompany(): Company {
  const root = process.cwd();
  const read = (f: string) => JSON.parse(readFileSync(f, "utf8")) as Partial<Company>;
  const custom = process.env.FFM_COMPANY_CONFIG;
  const cfg = custom ? read(custom) : { ...read(join(root, "company.config.json")), ...(existsSync(join(root, "company.config.local.json")) ? read(join(root, "company.config.local.json")) : {}) };
  return { applicationId: String(cfg.applicationId), authLinkDomain: String(cfg.authLinkDomain ?? "") };
}

const clean = (v: string | undefined) => (v ?? "").trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");

/** The App Link host the build was made with: VITE_FF_AUTH_LINK_DOMAIN, else company.config.json. */
export function linkDomain(): string {
  return clean(process.env.VITE_FF_AUTH_LINK_DOMAIN) || clean(loadCompany().authLinkDomain);
}
