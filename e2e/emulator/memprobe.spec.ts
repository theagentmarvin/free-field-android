import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { launchApp, PKG, SHOTS, type AppSession } from "../app";
import { appLinkFor, SEED, waitForSignInCode } from "./rest";
import { REAL_PROJECT_ID, seedRealData, type RealSeedResult } from "./realSeed";
import { killLines, memSnapshot, oomLines, rawMeminfo, workerHeaps, type MemSnapshot } from "./realMem";
import { ensureOnline, restoreNetwork } from "./network";

/**
 * Memory probe (opt-in lane for the tablet): the real demo data, then ARCHITECTURAL alone, ARCHITECTURAL + MECHANICAL
 * and all three, each in a FRESH app process, with the `dumpsys meminfo` breakdown (native, graphics, GL/EGL, swap)
 * and the worker heaps after load, after Fit and after a settle. Numbers go to test-results/memprobe-report.json.
 * MEMPROBE_CONFIGS="ARCH;ARCH,MECH;ARCH,MECH,STRUCT" overrides the configurations (needles of the model names).
 */
test.describe.configure({ mode: "serial" });
test.setTimeout(900_000);

const P = REAL_PROJECT_ID;
const REPORT = `${SHOTS}/memprobe-report.json`;
const report: Record<string, unknown> = {};
const record = (entries: Record<string, unknown>) => {
  Object.assign(report, entries);
  mkdirSync(SHOTS, { recursive: true });
  writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.log("MEMPROBE", JSON.stringify(entries));
};
// "NEEDLES" or "NEEDLES|{tuning json}" (the JSON goes to localStorage ffm.memCfg, see model/memoryConfig.ts)
const configs = (process.env.MEMPROBE_CONFIGS ?? "ARCH;ARCH,MECH;ARCH,MECH,STRUCT").split(";");

let seeded: RealSeedResult;
let app: AppSession;
const tab = (name: string) => app.page.getByTestId("tabs").getByRole("link", { name, exact: true });
const B = () => seeded.buildingId;
const within = <T>(ms: number, p: Promise<T>) => Promise.race([p.catch(() => undefined), new Promise<undefined>((r) => setTimeout(() => r(undefined), ms))]);
const jsHeap = () => app.page.evaluate(() => ((performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0) / 1048576).then((v) => Math.round(v)).catch(() => null);
const loaded = async () => Number((await app.page.getByTestId("model-page").getAttribute("data-loaded").catch(() => "0")) ?? 0);

async function snap(label: string): Promise<MemSnapshot> {
  const s = memSnapshot(label, await jsHeap());
  s.workerHeapsMb = await workerHeaps(app.page);
  const list = ((report.snapshots as MemSnapshot[] | undefined) ?? []).concat(s);
  record({ snapshots: list });
  return s;
}

test.beforeAll(async () => {
  await ensureOnline();
  seeded = await seedRealData([SEED.userMulti.uid]);
  app = await launchApp();
});
test.afterAll(async () => {
  await restoreNetwork(app);
  await app?.close().catch(() => undefined);
});

test("sign in, download the 3 models", async () => {
  await app.page.getByTestId("signin-email").fill(SEED.userMulti.email);
  await app.page.getByTestId("signin-submit").click();
  await expect(app.page.getByTestId("signin-sent")).toBeVisible();
  await app.shell(`am start -a android.intent.action.VIEW -p ${PKG} -d '${appLinkFor(await waitForSignInCode(SEED.userMulti.email))}'`);
  await app.page.getByTestId(`project-${P}`).click();
  await expect(app.page.getByTestId("tabs")).toBeVisible();
  await tab("More").click();
  await app.page.getByTestId("open-offline").click();
  await expect(app.page.getByTestId(`offline-building-${B()}`)).toBeVisible({ timeout: 120_000 });
  const est = app.page.getByTestId(`offline-estimate-${B()}`);
  await expect.poll(async () => Number((await est.getAttribute("data-bytes").catch(() => "0")) ?? 0), { timeout: 120_000 }).toBeGreaterThan(0);
  if (!/wifi/i.test((await app.page.getByTestId("offline-net").textContent()) ?? "")) await app.page.getByTestId("wifi-only").uncheck();
  await app.page.getByTestId(`offline-start-${B()}`).click();
  await expect(app.page.getByTestId(`offline-badge-${B()}`)).toHaveAttribute("data-state", "ready", { timeout: 600_000 });
  await snap("baseline-after-download");
});

for (const cfg of configs) {
  test(`probe: ${cfg}`, async () => {
    const [needles, tuningJson] = cfg.split("|");
    const want = needles.split(",").length;
    // fresh process per configuration: the previous scene's memory must not leak into this number
    await within(20_000, app.device.shell(`am force-stop ${PKG}`));
    await within(20_000, app.device.close());
    app = await launchApp({ clear: false });
    await app.page.evaluate(([c, t]) => {
      localStorage.setItem("ffm.modelOnly", c);
      if (t) localStorage.setItem("ffm.memCfg", t);
      else localStorage.removeItem("ffm.memCfg");
    }, [needles, tuningJson ?? ""]);
    await snap(`${cfg}: before`);
    await tab("Model").click();
    const t0 = Date.now();
    for (;;) {
      const n = await loaded();
      const phase = await app.page.getByTestId("model-page").getAttribute("data-phase").catch(() => null);
      if (n >= want && phase === "ready") break;
      if (phase === "failed" || Date.now() - t0 > 360_000) break;
      await new Promise((r) => setTimeout(r, 400));
    }
    const loadSeconds = Math.round((Date.now() - t0) / 100) / 10;
    record({ [`loadSeconds ${cfg}`]: loadSeconds, [`loaded ${cfg}`]: await loaded() });
    await snap(`${cfg}: loaded`);
    await app.page.waitForTimeout(12_000);
    await snap(`${cfg}: settled 12s`);
    await app.page.getByTestId("model-fit").click({ timeout: 120_000 }).catch(() => undefined);
    await app.page.waitForTimeout(8000);
    const after = await snap(`${cfg}: after fit`);
    writeFileSync(`${SHOTS}/memprobe-${want}-${Math.abs(hash(cfg))}-renderer.txt`, rawMeminfo(after.rendererPid) + "\n=====APP=====\n" + rawMeminfo(after.appPid));
    await app.shot(`memprobe-${want}`);
    record({ [`kills ${cfg}`]: killLines().slice(-5), [`oom ${cfg}`]: oomLines().slice(-3) });
    expect(after.rendererPid, "renderer survived").not.toBe("");
  });
}

const hash = (t: string) => [...t].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7);
