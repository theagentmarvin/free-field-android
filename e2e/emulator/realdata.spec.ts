import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test, type Locator } from "@playwright/test";
import { launchApp, PKG, SHOTS, touchSession, type AppSession } from "../app";
import { center, centralRegion, chooseLevel, closeFilters, dbg, deviceShot, expectGeometry, levelNames, openFilters, stageRect, waitReady } from "../model";
import { geometryStats } from "../png";
import { appLinkFor, listDocs, SEED, waitForSignInCode } from "./rest";
import { calibrationDocId } from "./realDataDocs";
import { REAL_PROJECT_ID, seedRealData, type RealSeedResult } from "./realSeed";
import { crashLines, killLines, memSnapshot, oomLines, type MemSnapshot } from "./realMem";
import { captureOnFailure, ensureOnline, restoreNetwork, setOffline } from "./network";

/**
 * Plans and the 3D model with the SAME data as the web app's demo dataset (apps/settings/public/seed):
 * 3 models (29 MB + 88.7 MB + 0.5 MB .frag), 2 PDFs, 15 storeys, a calibration and folders, published through
 * the Phase 1c/1d contract into the Firebase emulators and downloaded by the real offline layer.
 * One serial story; numbers go to test-results/realdata-report.json.
 */
test.describe.configure({ mode: "serial" });
test.setTimeout(900_000);

const P = REAL_PROJECT_ID;
const REPORT = `${SHOTS}/realdata-report.json`;
const report: Record<string, unknown> = {};
const record = (entries: Record<string, unknown>) => {
  Object.assign(report, entries);
  mkdirSync(SHOTS, { recursive: true });
  writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.log("REALDATA", JSON.stringify(entries));
};
const secs = (t0: number) => Math.round((Date.now() - t0) / 100) / 10;

let seeded: RealSeedResult;
let app: AppSession;
let touch: Awaited<ReturnType<typeof touchSession>>;
const mems: MemSnapshot[] = [];

const tab = (name: string) => app.page.getByTestId("tabs").getByRole("link", { name, exact: true });
const B = () => seeded.buildingId;
const runAs = (cmd: string) => app.shell(`run-as ${PKG} sh -c '${cmd}' 2>&1`);
const num = async (l: Locator, a: string) => Number(await l.getAttribute(a));
const jsHeap = () => app.page.evaluate(() => ((performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0) / 1048576).then((v) => Math.round(v)).catch(() => null);
const snap = async (label: string) => {
  const s = memSnapshot(label, await jsHeap());
  mems.push(s);
  record({ memory: mems });
  console.log("MEM", JSON.stringify(s));
  return s;
};
const loadedCount = async () => Number((await app.page.getByTestId("model-page").getAttribute("data-loaded").catch(() => "0")) ?? 0);
captureOnFailure(() => app);
test.afterEach(async ({}, info) => {
  if (info.status === info.expectedStatus) return;
  console.log("CRASH/ANR LINES", JSON.stringify({ crash: crashLines(), kills: killLines() }));
});

/** Latency of two animation frames (the federated scene renders on a software GPU, so a frame can take seconds). */
const frameLatencyMs = () =>
  app.page.evaluate(() => new Promise<number>((res) => { const t = performance.now(); requestAnimationFrame(() => requestAnimationFrame(() => res(Math.round(performance.now() - t)))); })).catch(() => -1);
const fitModel = async () => {
  const lat = await frameLatencyMs();
  const t0 = Date.now();
  await app.page.getByTestId("model-fit").click({ timeout: 240_000 });
  record({ [`fitClickMs_${Object.keys(report).length}`]: Date.now() - t0, frameLatencyBeforeFitMs: lat });
  await app.page.waitForTimeout(2500);
};

/** Never wait forever on a CDP/device call against a process that is being killed (a hang cost a whole 15 min test timeout once). */
const within = <T>(label: string, ms: number, p: Promise<T>): Promise<T | undefined> =>
  Promise.race([p.catch(() => undefined), new Promise<undefined>((r) => setTimeout(() => { console.log(`relaunch: ${label} did not finish in ${ms} ms, continuing`); r(undefined); }, ms))]);
const relaunch = async () => {
  await within("touch.detach", 10_000, touch?.detach() ?? Promise.resolve());
  await within("force-stop", 20_000, app.device.shell(`am force-stop ${PKG}`));
  await within("device.close", 20_000, app.device.close());
  app = await launchApp({ clear: false });
};

/**
 * Geometry check on the device framebuffer. On the software GPU a frame of this scene can be late, and the compositor
 * then shows a uniform (blank) surface for a moment: retry the capture for up to 90 s, count the blank captures in the
 * report, and fail with the usual assertion when it never shows geometry.
 */
const geometryEventually = async (name: string, min = 0.03) => {
  const t0 = Date.now();
  let blank = 0;
  for (;;) {
    const img = await deviceShot(app, name);
    const g = geometryStats(img, centralRegion(img));
    if (g.fraction > min && g.colours > 8) break;
    blank++;
    console.log(`geometry ${name}: blank capture #${blank} (${(g.fraction * 100).toFixed(1)} %, ${g.colours} colours)`);
    console.log("BLANK CAPTURE", JSON.stringify({ mem: memSnapshot("blank", null), kills: killLines() }));
    if (Date.now() - t0 > 90_000) return expectGeometry(app, name, min);
    await app.page.waitForTimeout(3000);
  }
  if (blank) record({ [`blankCaptures_${name}`]: blank });
};

/** Newest version of each plan (what the plan viewer opens; older revisions are also in the offline package, see offlineBytes). */
const latestPdfVersion = (fileId: string) =>
  seeded.manifest.tables.pdfVersions
    .filter((x) => x.pdfFileId === fileId)
    .reduce((best, x) => (Number(x.versionNumber ?? 0) > Number(best.versionNumber ?? 0) ? x : best));
const plans = () =>
  seeded.manifest.tables.pdfFiles.map((f) => {
    const v = latestPdfVersion(f.id as string);
    return { fileId: f.id as string, name: f.name as string, versionId: v.id as string, blobKey: v.blobKey as string };
  });
/**
 * Every revision of every plan. Since plan revisions shipped (revision history + compare work offline) the offline
 * package intentionally carries ALL synced PDF versions of a plan, newest first; the tile/viewer checks below still
 * use only the newest one (`plans()`).
 */
const allPdfVersions = () =>
  seeded.manifest.tables.pdfVersions.map((v) => ({ versionId: v.id as string, blobKey: v.blobKey as string }));
/** Bytes the offline package must download: every model `.frag` plus every revision of each plan. Never IFC. */
const offlineBytes = () =>
  seeded.blobs.filter((b) => b.kind !== "pdf").reduce((n, b) => n + (seeded.sizes.get(`${b.kind}:${b.sourceKey}`) ?? 0), 0) +
  allPdfVersions().reduce((n, p) => n + (seeded.sizes.get(`pdf:${p.blobKey}`) ?? 0), 0);

test.beforeAll(async () => {
  await ensureOnline();
  const t0 = Date.now();
  seeded = await seedRealData([SEED.userMulti.uid]);
  record({ seedSeconds: secs(t0), seedBytes: seeded.totalBytes, project: P, building: seeded.buildingName });
  app = await launchApp();
});
test.afterAll(async () => {
  await restoreNetwork(app);
  await touch?.detach().catch(() => undefined);
  await app?.close().catch(() => undefined);
});

test("sign in and pick the project", async () => {
  await app.page.getByTestId("signin-email").fill(SEED.userMulti.email);
  await app.page.getByTestId("signin-submit").click();
  await expect(app.page.getByTestId("signin-sent")).toBeVisible();
  await app.shell(`am start -a android.intent.action.VIEW -p ${PKG} -d '${appLinkFor(await waitForSignInCode(SEED.userMulti.email))}'`);
  await app.page.getByTestId(`project-${P}`).click();
  await expect(app.page.getByTestId("tabs")).toBeVisible();
  touch = await touchSession(app.page);
  await snap("baseline");
});

test("make available offline: estimate, progress, 3 models + every plan revision downloaded and sha-verified, tiles for every plan", async () => {
  await tab("More").click();
  await app.page.getByTestId("open-offline").click();
  await expect(app.page.getByTestId(`offline-building-${B()}`)).toBeVisible({ timeout: 120_000 });
  const est = app.page.getByTestId(`offline-estimate-${B()}`);
  // the estimate is only shown once every file doc has synced
  await expect.poll(async () => Number((await est.getAttribute("data-bytes").catch(() => "0")) ?? 0), { timeout: 120_000 }).toBeGreaterThan(0);
  const estimate = await num(est, "data-bytes");
  console.log("estimate", estimate, "expected", offlineBytes(), "(seeded incl. older revisions", seeded.totalBytes, ")", await est.innerText());
  expect(estimate).toBe(offlineBytes()); // the frags + every revision of each plan, nothing else (never IFC)
  expect(estimate / 1048576).toBeGreaterThan(100);
  expect(estimate / 1048576).toBeLessThan(130);
  await expect(app.page.getByTestId("offline-net")).toContainText("Online", { timeout: 30_000 });
  if (!/wifi/i.test((await app.page.getByTestId("offline-net").textContent()) ?? "")) await app.page.getByTestId("wifi-only").uncheck();

  await app.page.getByTestId(`offline-start-${B()}`).click();
  const t0 = Date.now();
  const doneAt: Record<string, number> = {};
  const progress: Array<{ t: number; fraction: number }> = [];
  for (;;) {
    const items = await app.page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid^="offline-item-"]')).map((e) => ({ id: e.getAttribute("data-testid")!.replace("offline-item-", ""), status: e.getAttribute("data-status")!, text: (e as HTMLElement).innerText.slice(0, 90) })),
    );
    const frac = Number((await app.page.getByTestId(`offline-progress-text-${B()}`).getAttribute("data-fraction").catch(() => "0")) ?? 0);
    progress.push({ t: secs(t0), fraction: frac });
    for (const i of items) if (i.status === "done" && doneAt[i.id] === undefined) doneAt[i.id] = secs(t0);
    if ((await app.page.getByTestId(`offline-badge-${B()}`).getAttribute("data-state")) === "ready") {
      // the badge can turn ready between the item snapshot and this read: take one last snapshot
      const last = await app.page.evaluate(() => Array.from(document.querySelectorAll('[data-testid^="offline-item-"]')).map((e) => ({ id: e.getAttribute("data-testid")!.replace("offline-item-", ""), status: e.getAttribute("data-status")! })));
      for (const i of last) if (i.status === "done" && doneAt[i.id] === undefined) doneAt[i.id] = secs(t0);
      break;
    }
    if ((await app.page.getByTestId(`offline-badge-${B()}`).getAttribute("data-state")) === "error") throw new Error(`download error: ${JSON.stringify(items)}`);
    if (Date.now() - t0 > 600_000) throw new Error(`download not finished in 10 min: ${JSON.stringify(items)}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  const downloadSeconds = secs(t0);
  const ids = Object.keys(doneAt);
  expect(ids.filter((i) => i.startsWith("frag:"))).toHaveLength(3);
  expect(ids.filter((i) => i.startsWith("pdf:"))).toHaveLength(allPdfVersions().length);
  const files = 3 + allPdfVersions().length;
  await expect(app.page.getByTestId(`offline-progress-text-${B()}`)).toContainText(`${files}/${files} files`);
  const mbps = Math.round((offlineBytes() / 1048576 / downloadSeconds) * 10) / 10;
  record({ download: { seconds: downloadSeconds, mbPerSec: mbps, estimateBytes: estimate, itemDoneAtSeconds: doneAt, progressSamples: progress.length } });

  // every blob on disk matches the sha256 of the seeded source, no leftover partial files
  const frags = seeded.fragVersions.map((v) => ({ path: `frag/${v.blobKey.replace(/[^A-Za-z0-9._-]/g, "_")}.frag`, sha: seeded.sha.get(`frag:${v.blobKey}`)! }));
  const pdfs = allPdfVersions().map((v) => ({ path: `pdf/${v.blobKey.replace(/[^A-Za-z0-9._-]/g, "_")}.pdf`, sha: seeded.sha.get(`pdf:${v.blobKey}`)! }));
  for (const f of [...frags, ...pdfs]) expect((await runAs(`sha256sum files/blobs/${f.path}`)).split(/\s+/)[0], f.path).toBe(f.sha);
  expect(await runAs("ls -1 files/blobs/frag files/blobs/pdf")).not.toContain(".part");

  const t1 = Date.now();
  for (const p of plans()) await expect(app.page.getByTestId(`offline-tiles-${p.versionId}`)).toHaveAttribute("data-tile-state", "ready", { timeout: 300_000 });
  const tiles = Object.fromEntries(await Promise.all(plans().map(async (p) => [p.name, await app.page.evaluate((v) => window.__ffmPlans!.tileCount(v), p.versionId)])));
  record({ tiles: { secondsAfterDownload: secs(t1), tileCounts: tiles } });
  for (const n of Object.values(tiles)) expect(n as number).toBeGreaterThan(10);
  await app.shot("realdata-offline-ready");
  await snap("after-download");
});

const calibId = () => {
  const c = seeded.manifest.tables.calibrations[0];
  return { pdfFileId: c.pdfFileId as string, storeyName: c.storeyName as string, id: calibrationDocId(c.pdfFileId, c.storeyName), transform: c.transformParams };
};
const pinPos = async () => {
  const b = (await app.page.locator('[data-testid="plan-pin"]').first().boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};

test("Plans tab: every plan under its folder; open each, pan and zoom, long-press pins, calibration applied", async () => {
  await tab("Plans").click();
  const building = app.page.getByTestId("plan-building");
  await expect(building).toHaveCount(1, { timeout: 60_000 });
  await expect(building.locator("h3")).toHaveText(seeded.buildingName);
  const groups = await app.page.getByTestId("plan-group").evaluateAll((gs) => gs.map((g) => ({ name: g.querySelector(".plan-group-name")?.textContent, plans: Array.from(g.querySelectorAll('[data-testid="plan-row"] strong')).map((s) => s.textContent) })));
  console.log("plan groups", JSON.stringify(groups));
  const folderOf = new Map(seeded.manifest.tables.pdfFolderAssignments.map((a) => [a.pdfFileId, seeded.manifest.tables.pdfFolders.find((f) => f.id === a.folderId)!.name as string]));
  for (const p of plans()) {
    const g = groups.find((x) => x.plans.includes(p.name));
    if (folderOf.has(p.fileId)) expect(g?.name, `${p.name} grouped under its folder`).toBe(folderOf.get(p.fileId));
    else expect(g, `${p.name} listed (no folder assignment)`).toBeTruthy();
    await expect(app.page.getByTestId("plan-row").filter({ hasText: p.name })).toHaveAttribute("data-tile-state", "ready");
  }
  const results: Record<string, unknown> = {};
  for (const p of plans()) {
    await tab("Plans").click();
    await app.page.getByTestId("plan-row").filter({ hasText: p.name }).getByTestId("plan-open").click();
    const viewer = app.page.getByTestId("plan-viewer");
    const t0 = Date.now();
    await expect(viewer).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => num(viewer, "data-drawn"), { timeout: 60_000 }).toBeGreaterThan(0);
    const openMs = Date.now() - t0;
    await app.page.getByTestId("plan-fit").click();
    await app.page.waitForTimeout(500);
    const z0 = await num(viewer, "data-zoom");
    const r = (await viewer.boundingBox())!;
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    // A pinch that loses its second finger after the first move (seen on the CPU-rendered emulator right after a long run of
    // earlier specs: zoom stops at exactly 1.25x) is retried from the fit view; a real zoom regression still fails all three.
    for (let attempt = 1; attempt <= 3; attempt++) {
      await touch.pinch(cx, cy, 80, 320);
      const zoomed = await expect.poll(() => num(viewer, "data-zoom"), { timeout: attempt === 3 ? 15_000 : 5_000 }).toBeGreaterThan(z0 * 1.3).then(() => true, (e) => { if (attempt === 3) throw e; return false; });
      if (zoomed) break;
      console.log(`pinch on ${p.name} stopped at zoom ${await num(viewer, "data-zoom")} (fit ${z0}); retry ${attempt}`);
      await app.page.getByTestId("plan-fit").click();
      await app.page.waitForTimeout(800);
    }
    const z1 = await num(viewer, "data-zoom");
    const tx = await num(viewer, "data-tx");
    await touch.drag(cx - 120, cy, cx + 120, cy + 30, 8);
    await expect.poll(() => num(viewer, "data-tx"), { timeout: 10_000 }).not.toBe(tx);
    await expect.poll(() => num(viewer, "data-drawn"), { timeout: 30_000 }).toBeGreaterThan(0);
    const level = await num(viewer, "data-level");
    await app.page.getByTestId("plan-fit").click();
    await app.page.waitForTimeout(500);

    // long-press -> New task here -> form with the plan's calibration -> pin
    const title = `Pin on ${p.name}`;
    // Same retry as the pinch: a touch sequence the CPU-rendered emulator drops is repeated, a missing menu still fails the third time.
    for (let attempt = 1; attempt <= 3; attempt++) {
      await touch.longPress(cx - 60, cy + 20);
      if (await app.page.getByTestId("plan-new-task").waitFor({ timeout: attempt === 3 ? 30_000 : 6_000 }).then(() => true, () => false)) break;
      console.log(`long press on ${p.name} opened no menu; retry ${attempt}`);
    }
    await app.page.getByTestId("plan-new-task").click();
    await expect(app.page.getByTestId("task-form")).toBeVisible();
    const calib = calibId();
    const calibrated = p.fileId === calib.pdfFileId;
    if (calibrated) await expect(app.page.getByTestId("task-storey")).toHaveValue(calib.storeyName, { timeout: 15_000 });
    else await expect(app.page.getByTestId("task-storey")).toHaveValue("");
    await app.page.getByTestId("task-title").fill(title);
    await app.page.getByTestId("task-submit").click();
    const pin = app.page.locator(`[data-testid="plan-pin"][aria-label$="${title}"]`);
    await expect(pin).toHaveCount(1, { timeout: 60_000 });
    await expect(pin).toHaveAttribute("data-revision", "current");
    await app.page.getByTestId("plan-fit").click();
    await app.page.waitForTimeout(600);
    const before = await pinPos();
    await app.shot(`realdata-plan-${p.name.slice(0, 5).toLowerCase()}-pins`);

    // the pin reached Firestore with the calibration (or the uncalibrated sentinel)
    await expect.poll(async () => (await listDocs(`projects/${P}/tasks`)).some((d) => d.data.title === title), { timeout: 90_000, intervals: [1000] }).toBe(true);
    const doc = (await listDocs(`projects/${P}/tasks`)).find((d) => d.data.title === title)!.data;
    const loc = doc.location as { storeyName: string | null; pdf: Record<string, unknown> };
    expect(loc.pdf).toMatchObject({ pdfFileId: p.fileId, pdfVersionId: p.versionId, page: 1, calibId: calibrated ? calib.id : "uncalibrated" });
    if (calibrated) expect(loc.storeyName).toBe(calib.storeyName);

    // reopen: the pin is where it was
    await tab("Tasks").click();
    await tab("Plans").click();
    await app.page.getByTestId("plan-row").filter({ hasText: p.name }).getByTestId("plan-open").click();
    await expect(app.page.locator(`[data-testid="plan-pin"][aria-label$="${title}"]`)).toHaveCount(1, { timeout: 60_000 });
    await app.page.getByTestId("plan-fit").click();
    await app.page.waitForTimeout(600);
    const after = await pinPos();
    expect(Math.hypot(after.x - before.x, after.y - before.y), "pin position after reopen").toBeLessThan(3);
    results[p.name] = { openMs, zoomFit: z0, zoomPinched: z1, finestLevelDrawn: level, calibrated, calibId: loc.pdf.calibId, pinPx: before, uv: loc.pdf.uv };
    record({ plans: results });
  }
});

test("model: all three models load (federated), geometry visible, storey chips match the synced storeys", async () => {
  await app.page.evaluate(() => {
    const w = window as unknown as { __long?: Array<{ at: number; ms: number }> };
    w.__long = [];
    try {
      new PerformanceObserver((l) => l.getEntries().forEach((e) => w.__long!.push({ at: Math.round(e.startTime), ms: Math.round(e.duration) }))).observe({ type: "longtask", buffered: true });
    } catch {
      /* longtask unsupported */
    }
  });
  const longTasks = async () => {
    const all = (await app.page.evaluate(() => (window as unknown as { __long?: Array<{ at: number; ms: number }> }).__long ?? []).catch(() => [])) as Array<{ at: number; ms: number }>;
    return { count: all.length, totalMs: all.reduce((n, x) => n + x.ms, 0), maxMs: Math.max(0, ...all.map((x) => x.ms)), worst: [...all].sort((a, b) => b.ms - a.ms).slice(0, 8) };
  };
  await snap("before-model");
  await tab("Model").click();
  const t0 = Date.now();
  const timeline: Array<{ loaded: number; seconds: number }> = [];
  let last = -1;
  for (;;) {
    const n = await loadedCount();
    if (n !== last) {
      timeline.push({ loaded: n, seconds: secs(t0) });
      last = n;
      console.log("models loaded", n, "at", secs(t0), "s");
    }
    const phase = await app.page.getByTestId("model-page").getAttribute("data-phase").catch(() => null);
    if (n >= 3 && phase === "ready") break;
    if (phase === "failed") break;
    if (Date.now() - t0 > 720_000) break;
    await new Promise((r) => setTimeout(r, 400));
  }
  record({ modelLoad: { timelineSeconds: timeline, phase: await app.page.getByTestId("model-page").getAttribute("data-phase").catch(() => null), oom: oomLines() } });
  await snap("model-loaded");
  const dbgState = await dbg(app.page, (d) => d.state()).catch(() => null);
  record({ modelState: { reloads: dbgState?.reloads, contextLosses: dbgState?.contextLosses, loadMsFirstModel: dbgState?.loadMs } });
  expect(await loadedCount(), "models loaded in the federated viewer").toBe(3);
  await expect(app.page.getByTestId("model-page")).toHaveAttribute("data-source", "downloaded");
  record({ longTasksAfterLoad: await longTasks() });
  // Input delay of the Fit tap (event creation to the capture listener, i.e. how long the main thread kept the input waiting):
  // this is the app's responsiveness. The click round trip and the frame latency also include software-GPU frame cost
  // (SwiftShader: 1 to 10 s per frame of this scene), so they are recorded as numbers only; real-device figures come from the tablet pass.
  await app.page.evaluate(() => {
    const w = window as unknown as { __inputDelay?: number[] };
    w.__inputDelay = [];
    for (const type of ["pointerdown", "click"]) {
      window.addEventListener(type, (e) => {
        if ((e.target as HTMLElement | null)?.closest?.('[data-testid="model-fit"]')) w.__inputDelay!.push(Math.round(performance.now() - e.timeStamp));
      }, true);
    }
  });
  const lat = await frameLatencyMs();
  const tc = Date.now();
  await app.page.getByTestId("model-fit").click({ timeout: 240_000 });
  const clickMs = Date.now() - tc;
  const delays = await app.page.evaluate(() => (window as unknown as { __inputDelay: number[] }).__inputDelay);
  const inputDelayMs = Math.max(0, ...delays);
  record({ responsiveAfterReady: { note: "software GPU (SwiftShader)", inputDelayMs, frameLatencyMs: lat, fitClickRoundTripMs: clickMs }, longTasksAfterFit: await longTasks() });
  expect(delays.length, "the Fit tap reached the page").toBeGreaterThan(0);
  expect(inputDelayMs, "input delay of the Fit tap after phase ready (ms)").toBeLessThan(1000);
  await app.page.waitForTimeout(3000);
  await geometryEventually("realdata-model-federated");

  // chips: one per distinct storey name of the synced rows
  const names = [...new Set(seeded.manifest.tables.storeys.map((s) => s.name as string))].sort();
  const chips = (await levelNames(app.page)).sort();
  console.log("chips", JSON.stringify(chips));
  expect(chips).toEqual(names);
});

test("model: tap-pick an element of each model, properties sheet; long-press pin in 3D; walk mode", async () => {
  await fitModel();
  const r = await stageRect(app.page);
  const hits = new Map<string, { x: number; y: number; localId: number }>();
  const scanStart = Date.now();
  let rays = 0;
  const scan = async (cols: number, rows: number) => {
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < cols; i++) {
        if (Date.now() - scanStart > 300_000) return; // budget: a raycast on the federated scene is slow on the software GPU
        rays++;
        const x = r.x + r.w * (0.1 + (i / (cols - 1)) * 0.8);
        const y = r.y + r.h * (0.15 + (j / (rows - 1)) * 0.7);
        const h = await dbg(app.page, (d, a) => d.elementAt(a.x, a.y), { x, y });
        if (h && !hits.has(h.modelId)) hits.set(h.modelId, { x, y, localId: h.localId });
      }
  };
  const files = new Map(seeded.manifest.tables.ifcFiles.map((f) => [f.id as string, f.name as string]));
  const structuralId = seeded.manifest.tables.ifcFiles.find((f) => /STRUCTURAL/i.test(f.name as string))!.id as string;
  const boxes = await dbg(app.page, (d) => d.modelBoxes());
  const nameOf = (id: string) => files.get(id) ?? id;
  record({ modelBoxes: boxes.map((b) => ({ model: nameOf(b.modelId), min: b.min.map((v) => Math.round(v * 100) / 100), max: b.max.map((v) => Math.round(v * 100) / 100) })) });
  await scan(14, 10);
  record({ raycast: { count: rays, totalSeconds: secs(scanStart), msEach: Math.round((Date.now() - scanStart) / Math.max(1, rays)) } });
  console.log("models reachable by raycast (federated view)", JSON.stringify([...hits].map(([m, h]) => [nameOf(m), h])));
  const picked: Record<string, boolean> = {};
  const tapPick = async (modelId: string, h: { x: number; y: number }) => {
    // One tap on the first raycast-visible element of the model: the app must open that element (viewer pick, or the
    // visibility-respecting raycast fallback after 0.7 s). Diagnostics only: what the raycast saw and how the tap was resolved.
    const pickedModel = async () => ((await dbg(app.page, (d) => d.state())).picked as { modelId: string } | null)?.modelId ?? null;
    if (await pickedModel()) await app.page.getByTestId("props-close").click({ timeout: 60_000 }).catch(() => undefined);
    const ray = await dbg(app.page, (d, a) => d.elementAt(a.x, a.y), { x: h.x, y: h.y });
    const tt = Date.now();
    await touch.tap(h.x, h.y);
    const ok = await expect
      .poll(pickedModel, { timeout: 30_000, intervals: [250] })
      .toBe(modelId)
      .then(() => true, () => false);
    const via = await app.page.evaluate(() => (window as unknown as { __ffmTap?: unknown }).__ffmTap ?? null);
    console.log("PICK COMPARE", JSON.stringify({ want: nameOf(modelId), raycast: ray ? { m: nameOf(ray.modelId), id: ray.localId } : null, picked: ok, ms: Date.now() - tt, via }));
    record({ [`tapPick_${nameOf(modelId).slice(0, 4)}`]: { ms: Date.now() - tt, via } });
    picked[nameOf(modelId)] = ok;
    if (ok) {
      await expect(app.page.getByTestId("props-sheet")).toBeVisible();
      const tp = Date.now();
      try {
        await expect(app.page.getByTestId("props-attrs")).toContainText("GlobalId", { timeout: 180_000 });
      } catch (e) {
        const text = (await app.page.getByTestId("props-sheet").innerText({ timeout: 5000 }).catch(() => "")).replace(/\s+/g, " ");
        const rec = await app.page.evaluate(() => (window as unknown as { __ffmProps?: unknown }).__ffmProps ?? null);
        console.log("PROPS DUMP", nameOf(modelId), JSON.stringify({ x: h.x, y: h.y, sheet: text.slice(0, 300), lastProps: rec }));
        throw e;
      }
      record({ [`propsSheetMs_${nameOf(modelId).slice(0, 4)}`]: Date.now() - tp, [`props_${nameOf(modelId).slice(0, 4)}`]: await app.page.evaluate(() => (window as unknown as { __ffmProps?: unknown }).__ffmProps ?? null) });
      await deviceShot(app, `realdata-model-props-${nameOf(modelId).slice(0, 4).toLowerCase()}`);
      await app.page.getByTestId("props-close").click();
    }
  };
  for (const [modelId, h] of hits) await tapPick(modelId, h);
  // A model that the fitted-view scan did not reach is occluded by the others (the boxes are aligned, the structure sits
  // inside the architecture): isolate a storey where that model has elements (synced `containedElementIds`) and pick there.
  for (const f of seeded.manifest.tables.ifcFiles) {
    const modelId = f.id as string;
    if (picked[nameOf(modelId)]) continue;
    const storeys = seeded.manifest.tables.storeys
      .filter((st) => st.sourceIfcFileId === modelId && (st.containedElementIds as number[]).length > 0)
      .sort((x, y) => (x.containedElementIds as number[]).length - (y.containedElementIds as number[]).length);
    for (const st of storeys.slice(0, 3)) {
      await chooseLevel(app.page, st.name as string);
      await app.page.waitForTimeout(4000);
      await fitModel();
      hits.clear();
      await scan(14, 10);
      if (!hits.has(modelId)) await scan(32, 22);
      console.log(`reachable with "${st.name}" isolated`, JSON.stringify([...hits.keys()].map(nameOf)));
      const h = hits.get(modelId);
      if (h) await tapPick(modelId, h);
      await deviceShot(app, `realdata-model-isolated-${nameOf(modelId).slice(0, 4).toLowerCase()}`);
      await chooseLevel(app.page, null);
      await app.page.waitForTimeout(4000);
      if (picked[nameOf(modelId)]) break;
    }
    await fitModel();
  }
  hits.clear();
  await scan(14, 10);
  record({ pick: { modelsReachable: [...hits.keys()].map(nameOf), picked } });
  expect(Object.values(picked).filter(Boolean).length, "all three models are pickable (structural via storey isolation)").toBe(3);

  // long-press -> New task here -> bim pin. The properties sheet must be closed and the point must hit the canvas.
  await expect(app.page.getByTestId("props-sheet")).toHaveCount(0);
  const first = hits.get([...hits.keys()].find((m) => m !== structuralId) ?? [...hits.keys()][0])!;
  const onCanvas = await app.page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest(".model-stage") && !document.elementFromPoint(x, y)?.closest("button, .model-sheet, .model-lp"), [first.x, first.y]);
  expect(onCanvas, "the long-press point is on the canvas, not on an overlay").toBe(true);
  const lpT = Date.now();
  await touch.longPress(first.x, first.y, 1000);
  await expect(app.page.getByTestId("model-lp")).toBeVisible({ timeout: 30_000 });
  record({ longPressToBarMs: Date.now() - lpT, longPressBreakdown: await app.page.evaluate(() => (window as unknown as { __ffmLongPress?: unknown }).__ffmLongPress ?? null) });
  await app.page.getByTestId("model-new-task").click();
  await expect(app.page.getByTestId("task-form")).toBeVisible();
  expect(decodeURIComponent(app.page.url())).toMatch(/anchor=bim:[\w-]+\.\d+@-?[\d.]+,-?[\d.]+,-?[\d.]+~/);
  await app.page.getByTestId("task-title").fill("Real model pin");
  await app.page.getByTestId("task-submit").click();
  // Save returns to the 3D view (new pin); open the task from its id to continue with "show in model"
  await expect(app.page.getByTestId("model-route")).toBeVisible({ timeout: 30_000 });
  const newId = (decodeURIComponent(app.page.url()).match(/[?&]task=([^&#]+)/) ?? [])[1];
  expect(newId).toBeTruthy();
  await app.page.goto(app.page.url().split("#")[0] + `#/tasks/${newId}`);
  await expect(app.page.getByTestId("task-detail")).toBeVisible({ timeout: 30_000 });
  await app.page.getByTestId("loc-model").click();
  await waitReady(app.page);
  await expect(app.page.locator('[data-testid="model-pin"]').first()).toHaveAttribute("data-visible", "true", { timeout: 60_000 });
  await deviceShot(app, "realdata-model-pin");
  // Saving the task navigates back to the Model tab, which remounts the viewer and reloads the
  // 3 models (~13 s on the software-GPU AVD); the pin can show before the last model is in.
  await expect.poll(loadedCount, { timeout: 120_000, message: "all 3 models reloaded after the pin" }).toBe(3);

  // walk mode
  await app.page.getByTestId("model-walk").click();
  await expect(app.page.getByTestId("walk-layer")).toBeVisible();
  // Walk starts where the view points, on the storey of that spot. From the fit view that is the roof of the top storey ("401 FOURTH
  // FLOOR", eye at ~10 m), where the eye sits in empty space above the content and the frame is one flat colour. A walker then picks
  // a lower level with the level stepper: do the same, until something is in view.
  for (let step = 0; step < 6; step++) {
    await app.page.waitForTimeout(2500);
    const probe = await deviceShot(app, "realdata-model-walk-probe");
    const g = geometryStats(probe, centralRegion(probe));
    if (g.fraction > 0.005 && g.colours > 8) break;
    const down = app.page.getByTestId("walk-level-down");
    if (!(await down.isEnabled())) break;
    console.log(`walk: nothing in view at level ${await app.page.getByTestId("walk-level-name").textContent()}, one level down`);
    await down.click();
  }
  await app.page.waitForTimeout(800);
  const w0 = (await dbg(app.page, (d) => d.pose()))!;
  expect(Number.isFinite(w0.pos[1])).toBe(true);
  const pad = await center(app.page.getByTestId("walk-pad"));
  const cdp = await app.page.context().newCDPSession(app.page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: pad.x, y: pad.y, id: 1 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: pad.x, y: pad.y - 55, id: 1 }] });
  await app.page.waitForTimeout(1500);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
  const w1 = (await dbg(app.page, (d) => d.pose()))!;
  const horiz = Math.hypot(w1.pos[0] - w0.pos[0], w1.pos[2] - w0.pos[2]);
  record({ walk: { walkedMeters: Math.round(horiz * 100) / 100, eyeY: w0.pos[1] } });
  expect(horiz).toBeGreaterThan(0.2);
  await geometryEventually("realdata-model-walk", 0.005);
  await app.page.getByTestId("walk-exit").click();
  await expect(app.page.getByTestId("model-page")).toHaveAttribute("data-mode", "orbit");
});

test("model tools on the federated scene: model chips, section box, isolate/hide, tree, search; memory does not grow", async () => {
  test.setTimeout(900_000);
  const tools = () => dbg(app.page, (d) => d.tools());
  const hiddenTotal = async () => Object.values((await tools()).hiddenCount).reduce((n, h) => n + h.n, 0);
  const openTool = async (id: string) => {
    await app.page.getByTestId("model-tools-button").click();
    await app.page.getByTestId(`tool-${id}`).click();
    await expect(app.page.getByTestId(`${id}-panel`)).toBeVisible({ timeout: 30_000 });
  };
  await fitModel();
  const before = await snap("tools-before");

  // 1. per-model chips: ARCHITECTURAL / MECHANICAL / STRUCTURAL_VDC
  await openFilters(app.page);
  const chips = app.page.getByTestId("filter-model");
  await expect(chips).toHaveCount(3);
  const labels = await chips.evaluateAll((els) => els.map((e) => e.getAttribute("data-label")));
  console.log("models in the Filters sheet", JSON.stringify(labels));
  const mech = app.page.locator('[data-testid="filter-model"][data-label*="MECHANICAL"]');
  const mechId = (await mech.getAttribute("data-model"))!;
  await deviceShot(app, "59-filters-sheet-3-models");
  await closeFilters(app.page);
  await deviceShot(app, "60-tools-3-models");
  await app.page.waitForTimeout(4000);
  const drawAll = await dbg(app.page, (d) => d.drawStats());
  await openFilters(app.page);
  await mech.locator("input").uncheck();
  await expect.poll(async () => (await tools()).hiddenCount[mechId]?.all, { timeout: 60_000 }).toBe(true);
  await closeFilters(app.page);
  await expect(app.page.getByTestId("filter-chip").first()).toContainText("2 of 3 models");
  await app.page.waitForTimeout(6000);
  const drawOff = await dbg(app.page, (d) => d.drawStats());
  record({ toolsDrawStats: { allModels: drawAll, mechanicalHidden: drawOff } });
  const mechOff = await snap("tools-mechanical-hidden");
  await deviceShot(app, "61-tools-mechanical-hidden");
  await app.page.getByTestId("filter-chip").first().click(); // the chip's x removes the model filter
  await expect.poll(async () => (await tools()).hiddenCount[mechId]?.all, { timeout: 60_000 }).toBe(false);
  await app.page.waitForTimeout(3000);
  record({ toolsHideMechanical: { totalPssBeforeMb: before.totalPssMb, totalPssHiddenMb: mechOff.totalPssMb, rendererBefore: before.rendererPssMb, rendererHidden: mechOff.rendererPssMb } });

  // 2. section box around the view
  await openTool("section");
  await app.page.getByTestId("section-box-view").click();
  await expect.poll(async () => (await tools()).section.enginePlanes.length, { timeout: 60_000 }).toBe(6);
  await deviceShot(app, "62-tools-section-panel");
  await app.page.getByTestId("section-close").click();
  await app.page.waitForTimeout(4000);
  await deviceShot(app, "63-tools-section-box");
  await snap("tools-section-box");

  // 3. isolate / hide / show all (selection by the viewer's own pick path: tap a point on screen)
  await openFilters(app.page);
  await expect(app.page.getByTestId("filter-category").first()).toBeVisible({ timeout: 120_000 });
  const cat = app.page.getByTestId("filter-category").first();
  const catName = (await cat.getAttribute("data-category"))!;
  await cat.locator("input").uncheck();
  await expect.poll(async () => (await tools()).hiddenCategories, { timeout: 60_000 }).toContain(catName);
  await expect.poll(hiddenTotal, { timeout: 60_000 }).toBeGreaterThan(0);
  await deviceShot(app, "64-tools-category-hidden");
  await app.page.getByTestId("filter-reset").click();
  await expect.poll(hiddenTotal, { timeout: 60_000 }).toBe(0);
  await closeFilters(app.page);

  // 4. tree: expand to an element and fly to it
  const pose0 = (await dbg(app.page, (d) => d.pose()))!;
  await openTool("tree");
  await expect(app.page.getByTestId("tree-row").first()).toBeVisible({ timeout: 120_000 });
  for (let i = 0; i < 10 && !(await app.page.locator('[data-testid="tree-row"][data-kind="element"]').count()); i++) {
    const t = app.page.locator('[data-testid="tree-row"]:has([data-testid="tree-toggle"][aria-expanded="false"]) [data-testid="tree-toggle"]').first();
    if (!(await t.count())) break;
    await t.click();
    await app.page.waitForTimeout(600);
  }
  await deviceShot(app, "65-tools-tree");
  const el = app.page.locator('[data-testid="tree-row"][data-kind="element"]').first();
  await expect(el).toBeVisible({ timeout: 30_000 });
  const id = Number(await el.getAttribute("data-local-id"));
  await el.getByTestId("tree-label").click();
  await expect.poll(async () => ((await dbg(app.page, (d) => d.state())).picked as { localId: number } | null)?.localId ?? null, { timeout: 60_000 }).toBe(id);
  await expect.poll(async () => { const p = await dbg(app.page, (d) => d.pose()); return p ? Math.hypot(p.pos[0] - pose0.pos[0], p.pos[1] - pose0.pos[1], p.pos[2] - pose0.pos[2]) : 0; }, { timeout: 60_000 }).toBeGreaterThan(0.05);
  await app.page.getByTestId("tree-close").click();

  // 5. search a GlobalId of the second model
  const sample = (await dbg(app.page, (d) => d.sampleElement(7)))!;
  await openTool("search");
  await app.page.getByTestId("search-input").fill(sample.guid!);
  const row = app.page.getByTestId("search-row").first();
  await expect(row).toBeVisible({ timeout: 120_000 });
  expect(Number(await row.getAttribute("data-local-id"))).toBe(sample.localId);
  await row.click();
  await expect.poll(async () => ((await dbg(app.page, (d) => d.state())).picked as { localId: number } | null)?.localId ?? null, { timeout: 60_000 }).toBe(sample.localId);
  await deviceShot(app, "66-tools-search");
  await app.page.getByTestId("search-close").click();

  // everything off again, then compare memory with the state before the tools
  await openTool("section");
  await app.page.getByTestId("section-reset").click();
  await app.page.getByTestId("section-close").click();
  await openFilters(app.page);
  await app.page.getByTestId("filter-reset").click();
  await closeFilters(app.page);
  await app.page.waitForTimeout(5000);
  const after = await snap("tools-after-everything-used-once");
  const growth = after.totalPssMb - before.totalPssMb;
  record({ toolsMemory: { totalPssBeforeMb: before.totalPssMb, totalPssAfterMb: after.totalPssMb, growthMb: growth, rendererBefore: before.rendererPssMb, rendererAfter: after.rendererPssMb, appBefore: before.appPssMb, appAfter: after.appPssMb, jsHeapBefore: before.jsHeapMb, jsHeapAfter: after.jsHeapMb } });
  expect(growth, "total PSS after using every tool once and restoring the view").toBeLessThan(120);
  expect(await loadedCount()).toBe(3);
  expect((await dbg(app.page, (d) => d.state())).contextLosses).toBe(0);
});

test("memory: 3 open/close cycles of the federated model, no context loss or OOM", async () => {
  const pid0 = mems[mems.length - 1].appPid;
  const cycles: Array<{ cycle: number; reloadSeconds: number; loaded: number }> = [];
  for (let c = 1; c <= 3; c++) {
    await tab("Tasks").click();
    await app.page.waitForTimeout(4000);
    await snap(`closed-${c}`);
    await tab("Model").click();
    const t0 = Date.now();
    await expect.poll(loadedCount, { timeout: 600_000, intervals: [500] }).toBe(3);
    cycles.push({ cycle: c, reloadSeconds: secs(t0), loaded: await loadedCount() });
    await app.page.waitForTimeout(3000);
    await snap(`open-${c}`);
  }
  const st = await dbg(app.page, (d) => d.state());
  const reg = await dbg(app.page, (d) => d.registry());
  const oom = oomLines();
  record({ cycles, afterCycles: { contextLosses: st.contextLosses, reloads: st.reloads, registry: reg, oomLines: oom, pidStable: mems[mems.length - 1].appPid === pid0 } });
  expect(reg).toMatchObject({ live: 1, overlaps: 0 });
  expect(st.contextLosses).toBe(0);
  expect(mems[mems.length - 1].appPid).toBe(pid0); // the app process was not killed
  await geometryEventually("realdata-model-after-cycles");
});

test("airplane mode and relaunch: every plan still opens from the tiles, pins are still there", async () => {
  test.setTimeout(300_000);
  await setOffline(app, true);
  await expect(app.page.getByTestId("sync-chip")).toHaveAttribute("data-state", "offline", { timeout: 60_000 });
  await relaunch();
  await expect(app.page.getByTestId("tabs")).toBeVisible({ timeout: 90_000 });
  touch = await touchSession(app.page);
  await tab("Plans").click();
  for (const p of plans()) {
    await app.page.getByTestId("plan-row").filter({ hasText: p.name }).getByTestId("plan-open").click();
    const viewer = app.page.getByTestId("plan-viewer");
    await expect(viewer).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => num(viewer, "data-drawn"), { timeout: 60_000 }).toBeGreaterThan(0);
    await expect(app.page.locator('[data-testid="plan-pin"]')).toHaveCount(1, { timeout: 30_000 });
    await expect(app.page.getByTestId("plan-preparing")).toHaveCount(0);
    await app.page.getByTestId("plan-back").click();
  }
  await app.shot("realdata-plans-offline-relaunch");
});

test("airplane mode and relaunch: the 3-model building still opens", async () => {
  test.setTimeout(420_000);
  await setOffline(app, true);
  await relaunch();
  await expect(app.page.getByTestId("tabs")).toBeVisible({ timeout: 90_000 });
  await expect(app.page.getByTestId("sync-chip")).toHaveAttribute("data-state", "offline", { timeout: 60_000 });
  await tab("Model").click();
  const t0 = Date.now();
  await expect.poll(loadedCount, { timeout: 600_000, intervals: [500] }).toBe(3);
  record({ offlineRelaunchModelSeconds: secs(t0) });
  await app.page.waitForTimeout(3000);
  await geometryEventually("realdata-model-offline-relaunch");
  await snap("offline-relaunch-model");
  expect(app.consoleErrors.filter((e) => /webgl|context lost/i.test(e))).toEqual([]);
});
