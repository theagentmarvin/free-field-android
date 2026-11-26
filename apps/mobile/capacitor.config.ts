import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CapacitorConfig } from "@capacitor/cli";
import { loadCompanyConfig } from "../../scripts/lib/company.mjs";

// Company settings (company.config.json at the repo root): app name and Android application id.
const company = loadCompanyConfig();

// WebView background = the web app background token (read from the vendored tokens.css).
const tokens = readFileSync(
  resolve(process.cwd(), "../../vendor/free-field/apps/settings/src/styles/tokens.css"),
  "utf8",
);
const accent = /--ff-blue-active:\s*(#[0-9a-fA-F]{6})/.exec(tokens)?.[1] ?? "#2563eb";
const bgApp = /--ff-bg-app:\s*(#[0-9a-fA-F]{6})/.exec(tokens)?.[1] ?? "#ffffff";

const config: CapacitorConfig = {
  appId: company.applicationId,
  appName: company.appName,
  webDir: "dist",
  backgroundColor: bgApp,
  android: {
    // Remote debugging is switched on natively for debug builds only
    // (MainActivity, BuildConfig.DEBUG); keep the Capacitor flag off.
    webContentsDebuggingEnabled: false,
    // Edge-to-edge insets are applied natively in MainActivity (content-root padding);
    // Capacitor's own margin adjustment stays off so the insets are not applied twice.
    adjustMarginsForEdgeToEdge: "disable",
    // Emulator e2e only: the page is https://localhost and talks to the Firebase
    // emulators over http://localhost (adb reverse). Never set for real builds.
    allowMixedContent: process.env.FFM_EMULATOR_BUILD === "true",
  },
  plugins: {
    SplashScreen: { launchShowDuration: 0 },
    LocalNotifications: { smallIcon: "ic_stat_ff", iconColor: accent },
  },
};

export default config;
