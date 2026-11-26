import { defineConfig } from "@playwright/test";

// Specs drive the installed debug APK through its WebView (Playwright `_android`).
// One worker, serial files: there is a single emulator and a single app instance.
export default defineConfig({
  testDir: "e2e",
  testIgnore: "**/emulator/**", // cloud-mode lane: playwright.emulator.config.ts
  outputDir: "test-results/playwright",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: [["list"], ["json", { outputFile: "test-results/e2e-report.json" }]],
});
