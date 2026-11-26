import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { launchApp, PKG, SHOTS, type AppSession } from "../app";
import { appLinkFor, SEED, waitForSignInCode } from "./rest";
import { randomBlob, readSample, SAMPLE_FRAG, SAMPLE_PDF, seedBuilding, sha256 } from "./offlineSeed";
import { startThrottleProxy } from "./throttle";
import { captureOnFailure, goOnline, ensureOnline, restoreNetwork, setOffline } from "./network";

/**
 * Offline packages against the Firebase emulators: blobs are uploaded to the Storage emulator, the metadata
 * docs reach the app through the real sync engine, and the downloads go through the native streaming plugin.
 * The device reaches Storage through a rate-limiting proxy (adb reverse 9199 -> proxy -> emulator) so a kill
 * can land mid-download.
 */
test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);

const OFF = Number(process.env.FFM_EMU_PORT_OFFSET ?? 0);
const SERIAL = process.env.ANDROID_SERIAL ?? "emulator-5554";
const alpha = SEED.projects[0];
const P = alpha.id;

const tower = { id: "b-tower", frag: readSample(SAMPLE_FRAG), pdf: readSample(SAMPLE_PDF) };
const corrupt = { id: "b-corrupt", pdf: readSample(SAMPLE_PDF) };
const killFrag = randomBlob(60 * 1024 * 1024);
const bigFrag = randomBlob(150 * 1024 * 1024);

let app: AppSession;
let proxy: Awaited<ReturnType<typeof startThrottleProxy>>;

const adb = (...args: string[]) => execFileSync("adb", ["-s", SERIAL, ...args], { encoding: "utf8" });
const runAs = (cmd: string) => app.shell(`run-as ${PKG} sh -c '${cmd}' 2>&1`);
const fileSha = async (rel: string) => (await runAs(`sha256sum files/blobs/${rel}`)).split(/\s+/)[0];
const ls = (dir: string) => runAs(`ls -1 files/blobs/${dir}`);
const tab = (name: string) => app.page.getByTestId("tabs").getByRole("link", { name, exact: true });
const badge = (id: string) => app.page.getByTestId(`offline-badge-${id}`);
const offline = (on: boolean) =>
  on ? setOffline(app, true) : goOnline(app, async (p) => /Online/.test((await p.getByTestId("offline-net").textContent()) ?? ""));
captureOnFailure(() => app);

async function openOffline() {
  await tab("More").click();
  await app.page.getByTestId("open-offline").click();
  await expect(app.page.getByTestId("offline-page")).toBeVisible();
}

async function signInAndPick() {
  await app.page.getByTestId("signin-email").fill(SEED.userMulti.email);
  await app.page.getByTestId("signin-submit").click();
  await expect(app.page.getByTestId("signin-sent")).toBeVisible();
  const url = appLinkFor(await waitForSignInCode(SEED.userMulti.email));
  await app.shell(`am start -a android.intent.action.VIEW -p ${PKG} -d '${url}'`);
  await app.page.getByTestId(`project-${P}`).click();
  await expect(app.page.getByTestId("tabs")).toBeVisible();
}

test.beforeAll(async () => {
  await ensureOnline();
  await seedBuilding({ projectId: P, buildingId: tower.id, name: "Tower", frag: tower.frag, pdf: tower.pdf });
  await seedBuilding({ projectId: P, buildingId: corrupt.id, name: "Corrupt", pdf: corrupt.pdf, pdfStored: new Uint8Array(corrupt.pdf).map((b, i) => (i === 100 ? b ^ 0xff : b)) });
  await seedBuilding({ projectId: P, buildingId: "b-kill", name: "Kill", frag: killFrag });
  proxy = await startThrottleProxy({ listen: 9199 + 2 * OFF, target: 9199 + OFF, bytesPerSec: 0 });
  adb("reverse", "tcp:9199", `tcp:${9199 + 2 * OFF}`);
  app = await launchApp();
});

test.afterAll(async () => {
  await restoreNetwork(app);
  await app?.close().catch(() => undefined);
  try {
    adb("reverse", "tcp:9199", `tcp:${9199 + OFF}`);
  } catch {
    /* emulator already gone */
  }
  await proxy?.close();
});

test("buildings synced through the engine are listed with a size estimate", async () => {
  await signInAndPick();
  await openOffline();
  for (const id of [tower.id, corrupt.id, "b-kill"]) await expect(app.page.getByTestId(`offline-building-${id}`)).toBeVisible({ timeout: 60_000 });
  const est = app.page.getByTestId(`offline-estimate-${tower.id}`);
  await expect(est).toHaveAttribute("data-bytes", String(tower.frag.length + tower.pdf.length));
  await expect(badge(tower.id)).toHaveAttribute("data-state", "none");
  await app.shot("offline-01-list");
});

test("make available offline: files land with a verified hash, progress and badge update", async () => {
  // The earlier cloud spec's airplane-mode toggles can leave the emulator reporting cellular; the Wi-Fi-only default would then refuse.
  if (!/wifi/i.test((await app.page.getByTestId("offline-net").textContent()) ?? "")) await app.page.getByTestId("wifi-only").uncheck();
  await app.page.getByTestId(`offline-start-${tower.id}`).click();
  await expect(badge(tower.id)).toHaveAttribute("data-state", "ready", { timeout: 90_000 });
  expect(await fileSha("frag/b-tower-ifc__v1.frag")).toBe(sha256(tower.frag));
  expect(await fileSha("pdf/b-tower-pdf__v1.pdf")).toBe(sha256(tower.pdf));
  expect(await ls("frag")).not.toContain(".part");
  expect(await ls("pdf")).not.toContain(".part");
  await expect(app.page.getByTestId(`offline-progress-text-${tower.id}`)).toContainText("2/2 files");
  await app.shot("offline-02-ready");
});

test("airplane mode: the building is still listed as offline-ready", async () => {
  await offline(true);
  await expect(app.page.getByTestId("offline-net")).toHaveText("Offline", { timeout: 45_000 });
  await expect(badge(tower.id)).toHaveAttribute("data-state", "ready");
  await app.page.reload();
  await expect(app.page.getByTestId("tabs")).toBeVisible({ timeout: 60_000 });
  await openOffline();
  await expect(badge(tower.id)).toHaveAttribute("data-state", "ready");
  await expect(app.page.getByTestId(`offline-start-${tower.id}`)).toHaveCount(0);
  await app.shot("offline-03-airplane");
  await offline(false);
  await expect(app.page.getByTestId("offline-net")).toContainText("Online", { timeout: 60_000 });
  console.log("network after airplane off:", await app.page.getByTestId("offline-net").textContent());
  // The emulator may report mobile data instead of Wi-Fi after airplane mode; the default Wi-Fi-only setting
  // would (correctly) refuse then. Wait for Wi-Fi, else turn the setting off for the rest of the story.
  const wifi = await expect(app.page.getByTestId("offline-net")).toContainText("wifi", { timeout: 20_000 }).then(() => true, () => false);
  if (!wifi) await app.page.getByTestId("wifi-only").uncheck();
});

test("kill the app mid-download, relaunch: the download resumes from the partial file and finishes", async () => {
  proxy.setRate(3 * 1024 * 1024);
  await app.page.getByTestId(`offline-start-b-kill`).click();
  await expect(app.page.getByTestId("offline-refusal")).toHaveCount(0);
  const text = app.page.getByTestId("offline-progress-text-b-kill");
  await expect.poll(async () => Number(await text.getAttribute("data-fraction")), { timeout: 60_000, intervals: [500] }).toBeGreaterThan(0.1);
  await new Promise((r) => setTimeout(r, 1500)); // let the journal flush
  const partBefore = Number((await runAs("stat -c %s files/blobs/frag/b-kill-ifc__v1.frag.part")).trim());
  expect(partBefore).toBeGreaterThan(1024 * 1024);
  expect(partBefore).toBeLessThan(killFrag.length);
  await app.device.shell(`am force-stop ${PKG}`);
  await app.device.close();

  app = await launchApp({ clear: false });
  await expect(app.page.getByTestId("tabs")).toBeVisible({ timeout: 60_000 });
  await openOffline();
  // The resumed request must ask for the rest of the file with a Range header (never restart from zero), and the
  // partial file must never shrink while it continues.
  await expect.poll(() => proxy.ranges.at(-1) ?? "", { timeout: 30_000 }).toMatch(/^bytes=\d+-$/);
  const resumedFrom = Number(/bytes=(\d+)-/.exec(proxy.ranges.at(-1) ?? "")?.[1]);
  expect(resumedFrom).toBeGreaterThanOrEqual(partBefore);
  for (let i = 0; i < 6; i++) {
    const now = Number((await runAs("stat -c %s files/blobs/frag/b-kill-ifc__v1.frag.part").catch(() => "0")).trim() || "0");
    if (now) expect(now).toBeGreaterThanOrEqual(partBefore);
    await new Promise((r) => setTimeout(r, 300));
  }
  proxy.setRate(0);
  await expect(badge("b-kill")).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
  expect(await fileSha("frag/b-kill-ifc__v1.frag")).toBe(sha256(killFrag));
  expect(await ls("frag")).not.toContain("b-kill-ifc__v1.frag.part");
});

test("corrupt checksum: error shown, nothing kept on disk", async () => {
  await app.page.getByTestId(`offline-start-${corrupt.id}`).click();
  await expect(badge(corrupt.id)).toHaveAttribute("data-state", "error", { timeout: 60_000 });
  await expect(app.page.getByTestId(`offline-error-pdf:b-corrupt-pv1`)).toContainText("Integrity check failed");
  const pdfDir = await ls("pdf");
  expect(pdfDir).not.toContain("b-corrupt-pdf__v1");
  await expect(app.page.getByTestId(`offline-retry-${corrupt.id}`)).toBeVisible();
  await app.shot("offline-04-corrupt");
});

test("remove the offline copy: files are gone and the badge resets", async () => {
  await app.page.getByTestId(`offline-remove-${tower.id}`).click();
  await expect(badge(tower.id)).toHaveCount(1);
  await expect(badge(tower.id)).toHaveAttribute("data-state", "none", { timeout: 30_000 });
  expect(await ls("frag")).not.toContain("b-tower-ifc__v1.frag");
  expect(await ls("pdf")).not.toContain("b-tower-pdf__v1.pdf");
});

test("150 MB model streams to disk: JS heap and process memory stay flat", async () => {
  await seedBuilding({ projectId: P, buildingId: "b-big", name: "Big Hall", frag: bigFrag });
  const start = app.page.getByTestId("offline-start-b-big");
  await expect(start).toBeVisible({ timeout: 60_000 });
  const mem = async () => {
    const dump = await app.shell(`dumpsys meminfo ${PKG}`);
    const kb = (re: RegExp) => Number(re.exec(dump)?.[1] ?? 0);
    const js = await app.page.evaluate(() => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0);
    return {
      totalPssKb: kb(/TOTAL PSS:\s+(\d+)/),
      javaHeapKb: kb(/Java Heap:\s+(\d+)/),
      nativeHeapKb: kb(/Native Heap:\s+(\d+)/),
      jsHeapMb: Math.round(js / 1048576),
    };
  };
  const base = await mem();
  const peak = { ...base };
  await start.click();
  const t0 = Date.now();
  for (;;) {
    const m = await mem();
    for (const k of Object.keys(peak) as Array<keyof typeof peak>) peak[k] = Math.max(peak[k], m[k]);
    if ((await badge("b-big").getAttribute("data-state")) === "ready") break;
    if (Date.now() - t0 > 240_000) throw new Error("big download did not finish");
    await new Promise((r) => setTimeout(r, 400));
  }
  const seconds = Math.round((Date.now() - t0) / 1000);
  const after = await mem();
  expect(await fileSha("frag/b-big-ifc__v1.frag")).toBe(sha256(bigFrag));
  const report = { fileMb: 150, seconds, base, peak, after };
  mkdirSync(SHOTS, { recursive: true });
  writeFileSync(`${SHOTS}/offline-memory.json`, JSON.stringify(report, null, 2));
  console.log("OFFLINE_MEMORY", JSON.stringify(report));
  // Streaming: a whole-file read would add >= 150 MB of JS heap (plus base64 overhead); allow generous slack.
  expect(peak.jsHeapMb - base.jsHeapMb).toBeLessThan(60);
  expect((peak.totalPssKb - base.totalPssKb) / 1024).toBeLessThan(150);
});
