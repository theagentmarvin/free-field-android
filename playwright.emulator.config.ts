import { defineConfig } from "@playwright/test";

// Cloud-mode specs: the APK built with scripts/emulator-env.sh, the Firebase
// auth/firestore/storage emulators on the host, adb-reversed into the device.
export default defineConfig({
  testDir: "e2e/emulator",
  outputDir: "test-results/playwright-emulator",
  globalSetup: "./e2e/emulator/global-setup.ts",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 30_000 },
  reporter: [["list"], ["json", { outputFile: "test-results/e2e-emulator-report.json" }]],
});
