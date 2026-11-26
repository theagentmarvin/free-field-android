import { expect, test } from "@playwright/test";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchApp, PKG, SHOTS, type AppSession } from "./app";
import { adb, pushToBlobStore, startMemorySampler } from "./perf";
import { execFileSync } from "node:child_process";

/**
 * Opt-in A/B of the plan renderer on the 20 MB A0 sheet (`FFM_PERF_AB=1`, takes 10-25 minutes):
 * every variant runs in a fresh app process so the renderer's memory starts from the same baseline.
 * Variants: FFM_PERF_VARIANTS=legacy,new (default). Results: test-results/plans-ab-<variant>.json and a
 * max-zoom crop of the same page region per variant.
 */
test.skip(!process.env.FFM_PERF_AB, "set FFM_PERF_AB=1 to run the renderer A/B");
test.describe.configure({ mode: "serial" });

type Tuning = "legacy" | Record<string, unknown>;
const VARIANTS: Record<string, Tuning> = {
  legacy: "legacy",
  new: {},
  "new-main": { worker: "off" },
  "new-whole": { ranged: false },
  "new-cleanup": { cleanupBetweenLevels: true },
  "budget12": { pyramid: { maxLongSide: 4096 } },
  "canvas2m": { maxCanvasPixels: 2 * 1024 * 1024 },
};
const names = (process.env.FFM_PERF_VARIANTS ?? "legacy,new").split(",");

let first = true;
for (const name of names) {
  test(`A0 render: ${name}`, async () => {
    test.setTimeout(30 * 60_000);
    const local = join(process.cwd(), ".cache", "large-a0.pdf");
    if (!existsSync(local)) execFileSync("node", ["scripts/gen-large-plan.mjs", local], { stdio: "inherit" });
    const tuning = VARIANTS[name];
    expect(tuning, `unknown variant ${name}`).toBeDefined();

    const app: AppSession = await launchApp({ clear: first });
    try {
      if (first) {
        pushToBlobStore(local, "pdf/large-a0.pdf");
        first = false;
      }
      await expect.poll(() => app.page.evaluate(() => !!window.__ffmPlans), { timeout: 30_000 }).toBe(true);
      expect(await app.page.evaluate(() => window.__ffmPlans!.hasPdf("large-a0"))).toBe(true);
      const pidBefore = adb("shell", `pidof ${PKG}`).trim();
      const vid = `large-a0-${name}`;
      const sampler = startMemorySampler();
      const t0 = Date.now();
      const stats = await app.page.evaluate(([v, t]) => window.__ffmPlans!.renderStored("large-a0", v, t as never), [vid, tuning] as const);
      const wallMs = Date.now() - t0;
      const peaks = await sampler.stop();
      const info = await app.page.evaluate((v) => window.__ffmPlans!.manifestInfo(v), vid);
      const tiles = await app.page.evaluate((v) => window.__ffmPlans!.tileCount(v), vid);
      const pidAfter = adb("shell", `pidof ${PKG}`).trim();
      // Same page region (points) for every variant: dense area near the centre, 400 x 260 pt at 1200 px wide.
      const png = await app.page.evaluate((v) => window.__ffmPlans!.cropPng(v, { x: 1500, y: 1000, w: 400, h: 260 }, 1200), vid);
      if (png) writeFileSync(join(SHOTS, `plans-ab-${name}-crop.png`), Buffer.from(png.split(",")[1], "base64"));
      const result = { variant: name, tuning, wallMs, stats, tiles, info, ...peaks, pidBefore, pidAfter };
      console.log("PLANS A/B:", JSON.stringify(result));
      writeFileSync(join(SHOTS, `plans-ab-${name}.json`), JSON.stringify(result, null, 2));
      expect(pidAfter).toBe(pidBefore);
      expect(tiles).toBeGreaterThan(100);
    } finally {
      await app.close().catch(() => undefined);
    }
  });
}
