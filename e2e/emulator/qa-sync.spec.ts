import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { launchApp, PKG, waitForTestHooks, type AppSession } from "../app";
import { restoreDevice, tryRoot } from "../qa";
import { appLinkFor, linkDomain, batchSet, deleteDoc, listAllDocs, listObjects, SEED, setDoc, Timestamp, waitForSignInCode } from "./rest";
import { randomBlob, seedBuilding, sha256 } from "./offlineSeed";
import { startThrottleProxy } from "./throttle";
import { captureOnFailure, ensureOnline, goOnline, listReverse, restoreNetwork, setOffline } from "./network";

/**
 * Exploratory QA in cloud mode (Firebase emulators): connectivity transitions, process death, clock skew,
 * membership loss, scale. Case numbers (A1..J65) refer to docs/qa/MATRIX.md. Everything a test changes on
 * the device (tunnels, airplane mode, clock, filler files) is restored in afterEach/afterAll.
 */
test.describe.configure({ mode: "serial" });
test.setTimeout(420_000);

const OFF = Number(process.env.FFM_EMU_PORT_OFFSET ?? 0);
const SERIAL = process.env.ANDROID_SERIAL ?? "emulator-5554";
const P = SEED.projects[0].id;
const adb = (...args: string[]) => execFileSync("adb", ["-s", SERIAL, ...args], { encoding: "utf8" });

let app: AppSession;
let proxy: Awaited<ReturnType<typeof startThrottleProxy>>;
let rooted = false;

const chip = () => app.page.getByTestId("sync-chip");
const tab = (name: string) => app.page.getByTestId("tabs").getByRole("link", { name, exact: true });
const tasksOf = async (title: string) => (await listAllDocs(`projects/${P}/tasks`)).filter((d) => d.data.title === title);
const createTask = async (title: string) => { await waitForTestHooks(app.page); return app.page.evaluate((t) => window.__ffmTest!.createTask(t), title); };
const createWithPhotos = async (title: string, n: number, kb: number) => { await waitForTestHooks(app.page); return app.page.evaluate(([t, c, k]) => window.__ffmTest!.createTaskWithPhotos(t as string, c as number, k as number), [title, n, kb] as const); };
const online = (page: AppSession["page"]) => page.getByTestId("sync-chip").getAttribute("data-state").then((s) => s === "online");
const goOffline = async () => {
  await setOffline(app, true);
  await expect(chip()).toHaveAttribute("data-state", "offline", { timeout: 45_000 });
};
const goBack = () => goOnline(app, online);
captureOnFailure(() => app);

/** "Connected but no internet": the OS reports a network, the tunnels to the backends are gone. */
const cutTunnels = () => {
  const saved = listReverse();
  for (const [dev] of saved) adb("reverse", "--remove", dev);
  return saved;
};
const restoreTunnels = (saved: Array<[string, string]>) => {
  for (const [dev, host] of saved) adb("reverse", dev, host);
};

/**
 * A reliable "link up, backend unreachable": removing the adb tunnels does not close connections the app already holds (the Firestore
 * write stream can keep delivering for a while), so restart the app after cutting them. The new process has no open connection.
 */
async function cutTunnelsFresh() {
  const saved = cutTunnels();
  await app.shell(`am force-stop ${PKG}`);
  await reattachAfterKill();
  return saved;
}

async function reattachAfterKill() {
  await app.device.close().catch(() => undefined);
  app = await launchApp({ clear: false });
  await expect(app.page.getByTestId("tabs")).toBeVisible({ timeout: 60_000 });
}

async function waitDrained(timeout = 90_000) {
  await expect(chip()).toHaveAttribute("data-pending", "0", { timeout });
}

test.beforeAll(async () => {
  await ensureOnline();
  proxy = await startThrottleProxy({ listen: 9199 + 2 * OFF, target: 9199 + OFF, bytesPerSec: 0 });
  adb("reverse", "tcp:9199", `tcp:${9199 + 2 * OFF}`);
  app = await launchApp();
  const tunnels = listReverse();
  rooted = await tryRoot(app);
  // tryRoot restarts adbd, which drops every `adb reverse` mapping (the sign-in then never reaches the Auth emulator) and
  // the Playwright device: restore the tunnels and reattach
  if (rooted) {
    await new Promise((r) => setTimeout(r, 1500));
    restoreTunnels(tunnels);
    await app.device.close().catch(() => undefined);
    app = await launchApp({ clear: false });
    // the devtools target of the app that was running while adbd restarted can linger: if the sign-in screen does not show up,
    // restart the app process (data is kept) and attach again
    for (let i = 0; i < 3 && !(await app.page.getByTestId("signin-email").isVisible().catch(() => false)); i++) {
      await app.page.getByTestId("signin-email").waitFor({ timeout: 10_000 }).catch(() => undefined);
      if (await app.page.getByTestId("signin-email").isVisible().catch(() => false)) break;
      await app.shell(`am force-stop ${PKG}`);
      await app.device.close().catch(() => undefined);
      app = await launchApp({ clear: false });
    }
  }
  await app.page.getByTestId("signin-email").fill(SEED.userMulti.email);
  await app.page.getByTestId("signin-submit").click();
  await expect(app.page.getByTestId("signin-sent")).toBeVisible();
  await app.shell(`am start -a android.intent.action.VIEW -p ${PKG} -d '${appLinkFor(await waitForSignInCode(SEED.userMulti.email))}'`);
  await app.page.getByTestId(`project-${P}`).click();
  await expect(app.page.getByTestId("tabs")).toBeVisible();
  await expect(chip()).toHaveAttribute("data-state", "online");
});
test.afterEach(async () => {
  try {
    proxy.setUploadRate(0);
    proxy.dropUploadAfter(0);
    adb("reverse", "tcp:9199", `tcp:${9199 + 2 * OFF}`);
  } catch {
    /* emulator gone */
  }
  await restoreNetwork(app);
});
test.afterAll(async () => {
  await restoreNetwork(app);
  await restoreDevice(app);
  await app?.close().catch(() => undefined);
  try {
    adb("reverse", "tcp:9199", `tcp:${9199 + OFF}`);
  } catch {
    /* emulator already gone */
  }
  await proxy?.close();
});

// ── A1 ────────────────────────────────────────────────────────────────────────

test("A1/B8 offline task with 3 photos, kill, relaunch offline, reconnect: one task, three distinct photos", async () => {
  await goOffline();
  const title = "QA A1 three photos";
  await createWithPhotos(title, 3, 200);
  await expect(chip()).toHaveAttribute("data-pending", /[1-9]/);
  await app.shell(`am force-stop ${PKG}`);
  await reattachAfterKill();
  await expect(chip()).toHaveAttribute("data-state", "offline");
  await expect(chip()).toHaveAttribute("data-pending", /[1-9]/);
  expect(await tasksOf(title)).toHaveLength(0);
  await goBack();
  await expect.poll(async () => (await tasksOf(title)).length, { timeout: 90_000, intervals: [1000] }).toBe(1);
  await waitDrained();
  await new Promise((r) => setTimeout(r, 4000));
  const docs = await tasksOf(title);
  expect(docs).toHaveLength(1);
  const photos = (docs[0].data.photos ?? []) as Array<{ storagePath: string }>;
  expect(photos).toHaveLength(3);
  expect(new Set(photos.map((p) => p.storagePath)).size).toBe(3);
  expect((await listObjects(`projects/${P}/tasks/${docs[0].id}`)).length).toBeGreaterThanOrEqual(3);
});

test("A1b reconnect and kill again during the commit: still exactly one task", async () => {
  await goOffline();
  const title = "QA A1b kill during commit";
  await createWithPhotos(title, 2, 600);
  proxy.setUploadRate(600 * 1024); // keep the commit in flight long enough for the kill to land in it
  await setOffline(app, false);
  await new Promise((r) => setTimeout(r, 2500));
  await app.shell(`am force-stop ${PKG}`);
  proxy.setUploadRate(0);
  await reattachAfterKill();
  await expect.poll(async () => (await tasksOf(title)).length, { timeout: 120_000, intervals: [1000] }).toBe(1);
  await waitDrained(120_000);
  await new Promise((r) => setTimeout(r, 4000));
  const docs = await tasksOf(title);
  expect(docs).toHaveLength(1);
  expect(((docs[0].data.photos ?? []) as unknown[]).length).toBe(2);
});

// ── A2 ────────────────────────────────────────────────────────────────────────

test("A2 connected but no internet: a short outage loses nothing and the work drains when the link works again", async () => {
  const saved = cutTunnels();
  const title = "QA A2 no internet";
  await createTask(title);
  await expect(chip()).toHaveAttribute("data-pending", "1");
  // shorter than the retry ladder needs to park a row (see A2c for the long outage)
  await new Promise((r) => setTimeout(r, 15_000));
  const failed = await chip().getAttribute("data-failed");
  console.log(`chip during a short outage: state=${await chip().getAttribute("data-state")} failed=${failed} text=${JSON.stringify((await chip().textContent()) ?? "")}`);
  await app.shot("qa-a2-no-internet");
  expect(failed, "a 15 s outage must not park the row").toBe("0");
  restoreTunnels(saved);
  await expect.poll(async () => (await tasksOf(title)).length, { timeout: 120_000, intervals: [1000] }).toBe(1);
  await waitDrained();
});

// BUG-13 (fixed by the vendored outbox, monorepo w74): while the OS says "online" but the backend is unreachable, network-class
// errors no longer count against a row's attempts; the row waits as Pending with a capped backoff. A long outage therefore
// never parks the task as Failed, and once the link works the task reaches the server exactly once without a manual Retry.
test("A2c [BUG-13] a long outage with the link up never parks the row as failed and loses nothing", async () => {
  const saved = await cutTunnelsFresh();
  const title = "QA A2c long outage";
  await createTask(title);
  await expect(chip()).toHaveAttribute("data-pending", "1");
  await new Promise((r) => setTimeout(r, 100_000)); // longer than 3 attempts plus the old back-offs
  const failed = await chip().getAttribute("data-failed");
  console.log(`A2c after 100 s without a backend: parked=${failed !== "0"} pending=${await chip().getAttribute("data-pending")} state=${await chip().getAttribute("data-state")}`);
  expect(failed, "a network outage must not park the row").toBe("0");
  expect(await chip().getAttribute("data-pending")).toBe("1");
  restoreTunnels(saved);
  await expect.poll(async () => (await tasksOf(title)).length, { timeout: 120_000, intervals: [1000] }).toBe(1);
  await waitDrained(120_000);
  expect(await chip().getAttribute("data-failed")).toBe("0");
});

// BUG-02 (fixed): the chip distinguishes "Offline" (no network) from "No connection to server" (link up, backend unreachable).
test("A2b [BUG-02] the chip says 'No connection to server' while the link is up but queued work cannot leave, and recovers", async () => {
  const saved = await cutTunnelsFresh();
  try {
    const title = "QA A2b no internet chip";
    await createTask(title);
    await expect(chip()).toHaveAttribute("data-pending", "1");
    await new Promise((r) => setTimeout(r, 15_000));
    await expect(chip()).toHaveAttribute("data-state", "unreachable");
    expect((await chip().textContent()) ?? "").toMatch(/No connection to server/);
    expect(await chip().getAttribute("data-failed")).toBe("0");
  } finally {
    restoreTunnels(saved);
    await waitDrained(120_000);
  }
  await expect(chip()).toHaveAttribute("data-state", "online", { timeout: 30_000 });
  expect((await chip().textContent()) ?? "").toMatch(/Online/);
});

// ── A3 ────────────────────────────────────────────────────────────────────────

test("A3 flapping connectivity every few seconds: one task, no failures, no duplicate uploads", async () => {
  const title = "QA A3 flapping";
  await createWithPhotos(title, 1, 400);
  for (let i = 0; i < 5; i++) {
    const saved = cutTunnels();
    await new Promise((r) => setTimeout(r, 3500));
    restoreTunnels(saved);
    await new Promise((r) => setTimeout(r, 3500));
  }
  await goBack().catch(() => undefined);
  await expect.poll(async () => (await tasksOf(title)).length, { timeout: 120_000, intervals: [1000] }).toBe(1);
  await waitDrained(120_000);
  await new Promise((r) => setTimeout(r, 4000));
  expect(await tasksOf(title)).toHaveLength(1);
  expect(await chip().getAttribute("data-failed")).toBe("0");
  const objs = await listObjects(`projects/${P}/tasks/${(await tasksOf(title))[0].id}`);
  console.log("objects after flapping:", objs.length);
  expect(objs.length).toBe(1);
});

// ── D21 / A5: connection dropped mid-upload ──────────────────────────────────

test("D21 the connection is cut in the middle of a photo upload: the task still arrives once, intact", async () => {
  const title = "QA D21 cut mid upload";
  proxy.dropUploadAfter(300 * 1024);
  await createWithPhotos(title, 1, 900);
  await expect.poll(async () => (await tasksOf(title)).length, { timeout: 120_000, intervals: [1000] }).toBe(1);
  await waitDrained(120_000);
  console.log("connections cut:", JSON.stringify(proxy.stats()));
  expect(proxy.stats().drops).toBeGreaterThanOrEqual(1);
  await new Promise((r) => setTimeout(r, 3000));
  const docs = await tasksOf(title);
  expect(docs).toHaveLength(1);
  const photo = ((docs[0].data.photos ?? []) as Array<{ storagePath: string; size?: number }>)[0];
  expect(photo).toBeTruthy();
  expect(await chip().getAttribute("data-failed")).toBe("0");
});

// ── B8 kill mid-upload ───────────────────────────────────────────────────────

test("B8 force-stop in the middle of a photo upload, relaunch: the upload restarts and the task arrives once", async () => {
  const title = "QA B8 killed mid upload";
  proxy.setUploadRate(300 * 1024);
  await createWithPhotos(title, 2, 700);
  await expect.poll(() => proxy.stats().uploadBytes, { timeout: 60_000, intervals: [500] }).toBeGreaterThan(100 * 1024);
  await app.shell(`am force-stop ${PKG}`);
  proxy.setUploadRate(0);
  await reattachAfterKill();
  await expect.poll(async () => (await tasksOf(title)).length, { timeout: 120_000, intervals: [1000] }).toBe(1);
  await waitDrained(120_000);
  await new Promise((r) => setTimeout(r, 4000));
  const docs = await tasksOf(title);
  expect(docs).toHaveLength(1);
  expect(((docs[0].data.photos ?? []) as unknown[]).length).toBe(2);
  expect(await chip().getAttribute("data-failed")).toBe("0");
});

// ── B11 app update ───────────────────────────────────────────────────────────

test("B11 reinstalling the app over itself (an update) keeps the pending outbox and the session", async () => {
  await goOffline();
  const title = "QA B11 survives update";
  await createTask(title);
  await expect(chip()).toHaveAttribute("data-pending", "1");
  const apk = process.env.FFM_APK ?? "apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk";
  adb("install", "-r", "-t", apk); // kills the app like an update does
  await app.device.close().catch(() => undefined);
  app = await launchApp({ clear: false });
  await expect(app.page.getByTestId("tabs")).toBeVisible({ timeout: 60_000 });
  await expect(app.page.getByTestId("signin-form")).toHaveCount(0);
  await expect(chip()).toHaveAttribute("data-pending", "1");
  await goBack();
  await expect.poll(async () => (await tasksOf(title)).length, { timeout: 90_000, intervals: [1000] }).toBe(1);
});

// ── A6 / A7 clock ────────────────────────────────────────────────────────────

function setClock(d: Date) {
  const p = (n: number) => String(n).padStart(2, "0");
  adb("shell", "settings", "put", "global", "auto_time", "0");
  adb("shell", "date", `${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${d.getUTCFullYear()}.${p(d.getUTCSeconds())}`);
}

test("A6/A7 clock eight days ahead while offline, then two hours behind online: session, queue and order hold", async () => {
  test.skip(!rooted, "needs a root shell to set the clock");
  const real = new Date();
  try {
    await goOffline();
    setClock(new Date(real.getTime() + 8 * 86_400_000));
    const t1 = "QA A7 created in the future";
    await createTask(t1);
    await app.shell(`am force-stop ${PKG}`);
    await reattachAfterKill();
    await expect(app.page.getByTestId("signin-form")).toHaveCount(0); // 8 days offline: the cached session is not thrown away
    await expect(chip()).toHaveAttribute("data-pending", "1");
    await app.shot("qa-a7-future-clock");
    // put the clock back, reconnect: queue drains
    setClock(new Date(real.getTime() + 5_000));
    await goBack();
    await expect.poll(async () => (await tasksOf(t1)).length, { timeout: 120_000, intervals: [1000] }).toBe(1);

    // two hours behind, online: token and writes still work, the new task is listed
    setClock(new Date(real.getTime() - 2 * 3_600_000));
    const t2 = "QA A7 created in the past";
    await createTask(t2);
    await expect.poll(async () => (await tasksOf(t2)).length, { timeout: 120_000, intervals: [1000] }).toBe(1);
    await tab("Tasks").click();
    await expect(app.page.getByTestId("task-row").filter({ hasText: t2 })).toHaveCount(1, { timeout: 30_000 });
    expect(await chip().getAttribute("data-failed")).toBe("0");
  } finally {
    adb("shell", "settings", "put", "global", "auto_time", "1");
    setClock(new Date(real.getTime() + 20_000));
    adb("shell", "settings", "put", "global", "auto_time", "1");
  }
});

// ── D27 membership removed while offline ─────────────────────────────────────

test("D27 membership removed while offline: the op ends failed with readable text, no endless retry, Retry works after re-adding", async () => {
  const title = "QA D27 denied";
  await goOffline();
  await createTask(title);
  await expect(chip()).toHaveAttribute("data-pending", "1");
  const member = `projects/${P}/members/${SEED.userMulti.uid}`;
  const memberDoc = { uid: SEED.userMulti.uid, role: "member", status: "active", joinedAt: new Timestamp(new Date().toISOString()), invitedBy: "e2e-seed" };
  await deleteDoc(member);
  try {
    await goBack().catch(() => undefined);
    // Losing the membership drops the user out of the project (the shell, and its chip, are replaced by the project picker), which
    // is intended. The rejected commit still has to come back and park the row: after a long offline spell the Firestore client
    // backs off its reconnect for up to about a minute, so give it that long before the membership is restored.
    const probe = async () =>
      (await app.page.getByTestId("project-picker").isVisible().catch(() => false)) ? "picker" : (await chip().getAttribute("data-failed", { timeout: 2_000 }).catch(() => null)) === "1" ? "chip" : "";
    const where = await expect.poll(probe, { timeout: 120_000, intervals: [2_000] }).not.toBe("").then(probe).catch(() => "neither");
    console.log(`D27 after membership loss the app shows: ${where}`);
    await new Promise((r) => setTimeout(r, 60_000));
  } finally {
    await setDoc(member, memberDoc);
  }
  // back in the project: the op must be parked as failed (not silently retried until it succeeded, which would also mean it was
  // never rejected), with readable text, and stay parked
  const pick = app.page.getByTestId(`project-${P}`);
  if (await pick.isVisible().catch(() => false)) await pick.click();
  await expect(chip()).toHaveAttribute("data-failed", "1", { timeout: 120_000 });
  await tab("Sync").click();
  const text = (await app.page.getByTestId("outbox-group").filter({ hasText: title }).textContent()) ?? "";
  console.log("outbox text:", JSON.stringify(text));
  await app.shot("qa-d27-failed");
  // the task title is part of the group text ("QA D27 denied"): look at the error line only
  const errLine = (await app.page.getByTestId("outbox-group").filter({ hasText: title }).locator(".err").first().textContent()) ?? "";
  expect(errLine).toMatch(/permission|not allowed|access/i);
  expect(errLine, "no internal rules trace for the user").not.toMatch(/evaluation error|L\d+/);
  await new Promise((r) => setTimeout(r, 20_000));
  expect(await chip().getAttribute("data-failed")).toBe("1"); // parked, not retrying forever
  expect(await tasksOf(title)).toHaveLength(0);
  await app.page.getByTestId("outbox-group").filter({ hasText: title }).getByTestId("outbox-retry").click();
  await expect.poll(async () => (await tasksOf(title)).length, { timeout: 90_000, intervals: [1000] }).toBe(1);
});

// ── H51 a sign-in link that is not for this device ───────────────────────────

test("H51 a stray or forged email-link while signed in does not sign the user out", async () => {
  await app.shell(`am start -a android.intent.action.VIEW -p ${PKG} -d 'https://${linkDomain()}/finish-sign-in?mode=signIn&oobCode=forged&apiKey=fake-api-key'`);
  await app.page.waitForTimeout(4000);
  await expect(app.page.getByTestId("tabs")).toBeVisible();
  await expect(app.page.getByTestId("signin-form")).toHaveCount(0);
});

// ── C17 cache trim ───────────────────────────────────────────────────────────

test("C17/C19 the OS trimming app caches keeps queued work, drafts and the session", async () => {
  await goOffline();
  const title = "QA C17 cache trim";
  await createWithPhotos(title, 1, 300);
  await tab("Tasks").click();
  await app.page.getByTestId("new-task").click();
  await app.page.getByTestId("task-title").fill("QA C17 draft");
  await expect(app.page.getByTestId("draft-status")).toHaveAttribute("data-saved", "1", { timeout: 10_000 });
  adb("shell", "pm", "trim-caches", "999G");
  await app.shell(`am force-stop ${PKG}`);
  await reattachAfterKill();
  await expect(chip()).toHaveAttribute("data-pending", "1");
  await tab("Tasks").click();
  await app.page.getByTestId("folder-drafts").click();
  await expect(app.page.getByTestId("draft-row").filter({ hasText: "QA C17 draft" })).toBeVisible();
  await app.page.getByTestId("draft-delete").first().click();
  await goBack();
  await expect.poll(async () => (await tasksOf(title)).length, { timeout: 90_000, intervals: [1000] }).toBe(1);
  expect(((await tasksOf(title))[0].data.photos as unknown[]).length).toBe(1);
});

// ── J65 back-pressure ────────────────────────────────────────────────────────

test("J65 200 tasks queued offline: the UI stays responsive, new tasks can still be created, everything drains once", async () => {
  test.setTimeout(900_000);
  await goOffline();
  const prefix = "QA J65 task";
  const t0 = Date.now();
  await app.page.evaluate(async (p) => {
    for (let i = 0; i < 200; i++) await window.__ffmTest!.createTask(`${p} ${i}`);
  }, prefix);
  console.log(`queued 200 creates in ${Date.now() - t0} ms`);
  await expect(chip()).toHaveAttribute("data-pending", "200");
  // the form still opens and submits while the queue is deep
  await tab("Tasks").click();
  const t1 = Date.now();
  await app.page.getByTestId("new-task").click();
  await app.page.getByTestId("task-title").fill("QA J65 interactive");
  await app.page.getByTestId("task-submit").click();
  await expect(app.page.getByTestId("detail-title")).toHaveText("QA J65 interactive", { timeout: 20_000 });
  console.log(`interactive create with a 200-deep queue: ${Date.now() - t1} ms`);
  await goBack();
  const tDrain = Date.now();
  await waitDrained(600_000);
  console.log(`drained 201 queued creates in ${Math.round((Date.now() - tDrain) / 1000)} s`);
  await new Promise((r) => setTimeout(r, 5000));
  const all = await listAllDocs(`projects/${P}/tasks`);
  const mine = all.filter((d) => String(d.data.title).startsWith(prefix));
  expect(mine).toHaveLength(200);
  expect(new Set(mine.map((d) => d.data.title)).size).toBe(200);
  expect(all.filter((d) => d.data.title === "QA J65 interactive")).toHaveLength(1);
});

// ── J53 / J61 many tasks ─────────────────────────────────────────────────────

const MANY = 2000;

/** PERF-1 diagnosis: CPU-profile the page for `ms` and log the heaviest functions by self time (FFM_J65B_PROFILE=1). */
async function profileTop(page: AppSession["page"], ms: number) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.start");
  await new Promise((r) => setTimeout(r, ms));
  const { profile } = (await cdp.send("Profiler.stop")) as { profile: { nodes: { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; children?: number[] }[]; samples: number[]; timeDeltas: number[] } };
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map<string, number>();
  profile.samples.forEach((id, i) => {
    const f = byId.get(id)!.callFrame;
    const k = `${f.functionName || "(anon)"} ${f.url.split("/").slice(-2).join("/")}:${f.lineNumber}`;
    self.set(k, (self.get(k) ?? 0) + (profile.timeDeltas[i] ?? 0) / 1000);
  });
  const total = [...self.values()].reduce((a, b) => a + b, 0);
  console.log(`cpu profile over ${ms} ms (sampled ${Math.round(total)} ms):`);
  for (const [k, v] of [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`  ${Math.round(v)} ms  ${k}`);
}

test("J53 a project with 2,000 tasks: every task is reachable, counts are honest, search is fast", async () => {
  const sample = (await listAllDocs(`projects/${P}/tasks`))[0];
  expect(sample, "an earlier test created a task to clone").toBeTruthy();
  const stamp = (iso: string) => new Timestamp(iso);
  const docs = Array.from({ length: MANY }, (_, i) => {
    const id = `qa-seed-${String(i).padStart(4, "0")}`;
    const ts = new Date(Date.now() - (i + 1) * 60_000).toISOString();
    const data: Record<string, unknown> = { ...sample.data, id, title: `QA seed ${i}`, num: 1000 + i, status: 20, createdAt: stamp(ts), updatedAt: stamp(ts), photos: [], assigneeUid: null, assigneeName: null, deadline: null };
    for (const k of ["completedAt", "approvedAt", "closedAt", "deletedAt"]) if (k in data) data[k] = null;
    return { path: `projects/${P}/tasks/${id}`, data };
  });
  await batchSet(docs);
  await tab("Sync").click();
  await tab("Tasks").click();
  await app.page.getByTestId("chip-open").click();
  const rows = app.page.getByTestId("task-row");
  await expect(rows.first()).toBeVisible({ timeout: 60_000 });
  // all of them must be reachable by loading more pages. The button disappears while a page is loading, so "no button" does not mean
  // "done": keep clicking it whenever it shows up until the Open count reaches the total (bounded by the poll timeout).
  const t0 = Date.now();
  const readOpen = async () => Number((await app.page.getByTestId("chip-open").locator(".count").textContent()) ?? "0");
  await expect
    .poll(
      async () => {
        const more = app.page.getByTestId("load-more");
        if (await more.isVisible().catch(() => false)) await more.click({ timeout: 5_000 }).catch(() => undefined);
        return readOpen();
      },
      { timeout: 120_000, intervals: [1_000] },
    )
    .toBeGreaterThanOrEqual(MANY)
    .catch(() => undefined); // the assertion below reports the final count
  console.log(`paged to the end in ${Date.now() - t0} ms; rows in DOM: ${await rows.count()}`);
  const open = await readOpen();
  console.log("Open folder count:", open);
  await app.shot("qa-j53-many");
  expect(open, "the Open count must include every synced task").toBeGreaterThanOrEqual(MANY);
  // search: time from the input event to the matching row, measured inside the page (Playwright's own round trips to the emulator
  // cost hundreds of ms each and are not the app's)
  const ms = await app.page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const input = document.querySelector<HTMLInputElement>('[data-testid="task-search"]')!;
        const rows = () => Array.from(document.querySelectorAll('[data-testid="task-row"]'));
        const done = () => {
          const r = rows();
          // filtered (fewer rows than before the keystroke) and the old task is among them, exactly once
          return r.length < before && r.filter((x) => (x.textContent ?? "").includes("QA seed 1999")).length === 1;
        };
        const before = rows().length;
        const t0 = performance.now();
        const timer = setTimeout(() => reject(new Error(`search never filtered the list (rows before ${before}, now ${rows().length})`)), 20_000);
        const obs = new MutationObserver(() => {
          if (done()) {
            clearTimeout(timer);
            obs.disconnect();
            requestAnimationFrame(() => resolve(performance.now() - t0));
          }
        });
        obs.observe(document.body, { childList: true, subtree: true, characterData: true });
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
        set.call(input, "QA seed 1999");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }),
  );
  console.log(`search to result (in page): ${Math.round(ms)} ms`);
  expect(ms).toBeLessThan(3000);
  await app.page.getByTestId("task-search").fill("");
  // scroll jank probe: time to open a task detail while 2,000 rows exist
  const t2 = Date.now();
  await rows.first().click();
  await expect(app.page.getByTestId("task-detail")).toBeVisible();
  console.log(`open detail with ${MANY} rows: ${Date.now() - t2} ms`);
});

// PERF-1: the drain rate with all 2,000 tasks loaded and the list on screen must stay close to the fresh-project rate (J65).
test("J65b 200 queued creates drain at close to the fresh rate while 2,000 tasks are loaded in the list", async () => {
  test.setTimeout(900_000);
  await tab("Tasks").click();
  await app.page.getByTestId("chip-open").click();
  const readOpen = async () => Number((await app.page.getByTestId("chip-open").locator(".count").textContent()) ?? "0");
  await expect
    .poll(
      async () => {
        const more = app.page.getByTestId("load-more");
        if (await more.isVisible().catch(() => false)) await more.click({ timeout: 5_000 }).catch(() => undefined);
        return readOpen();
      },
      { timeout: 120_000, intervals: [1_000] },
    )
    .toBeGreaterThanOrEqual(MANY);
  await goOffline();
  const prefix = "QA J65b task";
  await app.page.evaluate(async (p) => {
    for (let i = 0; i < 200; i++) await window.__ffmTest!.createTask(`${p} ${i}`);
  }, prefix);
  await expect(chip()).toHaveAttribute("data-pending", "200");
  // PERF-1 diagnostics: FFM_J65B_TAB=Sync drains with the list unmounted (no task listener, no row rendering)
  if (process.env.FFM_J65B_TAB) await tab(process.env.FFM_J65B_TAB).click();
  await app.page.evaluate(() => {
    const w = window as unknown as { __long: { n: number; ms: number } };
    w.__long = { n: 0, ms: 0 };
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        w.__long.n += 1;
        w.__long.ms += e.duration;
      }
    }).observe({ entryTypes: ["longtask"] });
  });
  await goBack();
  const tDrain = Date.now();
  if (process.env.FFM_J65B_PROFILE) await profileTop(app.page, 45_000);
  await waitDrained(900_000);
  const secs = (Date.now() - tDrain) / 1000;
  const long = await app.page.evaluate(() => (window as unknown as { __long: { n: number; ms: number } }).__long);
  console.log(`main-thread long tasks during the drain: ${long.n} tasks, ${Math.round(long.ms)} ms of ${Math.round(secs * 1000)} ms`);
  console.log(`drained 200 queued creates with ${MANY} tasks loaded in ${Math.round(secs)} s (${((secs * 1000) / 200).toFixed(0)} ms/op)`);
  await new Promise((r) => setTimeout(r, 5000));
  const mine = (await listAllDocs(`projects/${P}/tasks`)).filter((d) => String(d.data.title).startsWith(prefix));
  expect(mine).toHaveLength(200);
});

// ── E35 / C15: plans ─────────────────────────────────────────────────────────

test("E35 a plan file that is not a PDF: the tile render ends in an error with Retry, never an endless spinner", async () => {
  const garbage = randomBlob(40 * 1024);
  await seedBuilding({ projectId: P, buildingId: "b-garbage", name: "Garbage", pdf: garbage });
  await tab("More").click();
  await app.page.getByTestId("open-offline").click();
  await expect(app.page.getByTestId("offline-building-b-garbage")).toBeVisible({ timeout: 60_000 });
  if (!/wifi/i.test((await app.page.getByTestId("offline-net").textContent()) ?? "")) await app.page.getByTestId("wifi-only").uncheck().catch(() => undefined);
  await app.page.getByTestId("offline-start-b-garbage").click();
  await expect(app.page.getByTestId("offline-badge-b-garbage")).toHaveAttribute("data-state", "ready", { timeout: 90_000 });
  await tab("Plans").click();
  const row = app.page.getByTestId("plan-row").filter({ hasText: "Garbage plan" });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row).not.toHaveAttribute("data-tile-state", "rendering", { timeout: 120_000 });
  const state = await row.getAttribute("data-tile-state");
  console.log("tile state of a non-PDF plan:", state, "badge:", await row.getByTestId("plan-badge").textContent());
  await app.shot("qa-e35-garbage-plan");
  expect(["error", "failed", "none"]).toContain(state);
  expect(sha256(garbage)).toBeTruthy();
});

test("C15 storage runs out during a download: the download stops with a message, the part stays, and Resume finishes it", async () => {
  test.skip(!rooted, "needs a root shell to fill /data");
  const frag = randomBlob(80 * 1024 * 1024);
  await seedBuilding({ projectId: P, buildingId: "b-fill", name: "Fill", frag });
  // slow enough (80 s for 80 MB) that the multi-GB filler below, which takes tens of seconds to write, wins the race
  proxy.setRate(1024 * 1024);
  await tab("More").click();
  await app.page.getByTestId("open-offline").click();
  await expect(app.page.getByTestId("offline-building-b-fill")).toBeVisible({ timeout: 60_000 });
  if (!/wifi/i.test((await app.page.getByTestId("offline-net").textContent()) ?? "")) await app.page.getByTestId("wifi-only").uncheck().catch(() => undefined);
  await app.page.getByTestId("offline-start-b-fill").click();
  await expect(app.page.getByTestId("offline-progress-text-b-fill")).toContainText(/MB|%/, { timeout: 60_000 });
  // take the free space away while bytes are flowing
  // fill /data down to ~6 MB free; the first dd can stop short (other writers), so top up until the target is met
  const freeKb = async () => Number((await app.shell("df -k /data | tail -1")).trim().split(/\s+/)[3]);
  for (let i = 0; i < 4 && (await freeKb()) > 8 * 1024; i++) {
    const fillKb = Math.max(0, (await freeKb()) - 6 * 1024);
    await app.shell(`dd if=/dev/zero of=/data/local/tmp/ffm-qa-filler${i} bs=1024 count=${fillKb} 2>&1 | tail -1`);
  }
  console.log(`free after the filler: ${await freeKb()} KB`);
  try {
    const badge = app.page.getByTestId("offline-badge-b-fill");
    // progress log every 30 s: a stalled transfer (no bytes moving) must be told apart from a download that simply is not failing
    const prog = setInterval(() => {
      void app.page
        .getByTestId("offline-progress-text-b-fill")
        .textContent({ timeout: 2_000 })
        .then((t) => console.log(`C15 progress: ${t}`))
        .catch(() => undefined);
    }, 30_000);
    try {
      await expect(badge).not.toHaveAttribute("data-state", "downloading", { timeout: 240_000 });
    } finally {
      clearInterval(prog);
    }
    console.log("state after the disk filled:", await badge.getAttribute("data-state"), "text:", (await app.page.getByTestId("offline-page").textContent())?.slice(0, 300));
    await app.shot("qa-c15-disk-full");
    await expect(app.page.getByTestId("offline-page")).toContainText(/storage|space|disk/i);
  } finally {
    await app.shell("rm -f /data/local/tmp/ffm-qa-filler*");
    proxy.setRate(0);
  }
  // The stall watchdog fails the download with a plain storage message (even when the WebView's IndexedDB stays broken after the
  // disk filled: the state is then held in memory). Space is free again: Retry must finish the download from the kept part with
  // NO app restart.
  const badge = app.page.getByTestId("offline-badge-b-fill");
  await expect(badge).toHaveAttribute("data-state", "error", { timeout: 30_000 });
  await expect(app.page.getByTestId("offline-page")).not.toContainText(/backing store|ENOSPC/i);
  await expect(app.page.getByTestId("offline-retry-b-fill")).toBeVisible();
  await expect
    .poll(
      async () => {
        const retry = app.page.getByTestId("offline-retry-b-fill");
        if (await retry.isVisible().catch(() => false)) await retry.click({ timeout: 5_000 }).catch(() => undefined);
        return badge.getAttribute("data-state", { timeout: 5_000 }).catch(() => null);
      },
      { timeout: 180_000, intervals: [3_000] },
    )
    .toBe("ready");
});
