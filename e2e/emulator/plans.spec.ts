import { expect, test, type Locator } from "@playwright/test";
import { launchApp, PKG, touchSession, type AppSession } from "../app";
import { appLinkFor, listDocs, SEED, setDoc, Timestamp, waitForSignInCode } from "./rest";
import { readSample, SAMPLE_PDF, seedBuilding } from "./offlineSeed";
import { captureOnFailure, ensureOnline, goOnline, restoreNetwork, setOffline } from "./network";

/**
 * Plans on top of the offline layer, against the Firebase emulators. One serial story:
 * a building seeded with a PDF version is made available offline -> its tiles are rendered when the download
 * finishes -> in airplane mode the plan opens from those tiles without rendering anything -> a task pinned
 * there reaches Firestore with `location.pdf.pdfVersionId`.
 */
test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);

const P = SEED.projects[0].id;
const B = "b-plans";
const VERSION = `${B}-pv1`;
const FILE = `${B}-pdf`;
const PLAN_NAME = "Plans Tower plan";
const TITLE = "Pin with a revision";

let app: AppSession;
let touch: Awaited<ReturnType<typeof touchSession>>;

const tab = (name: string) => app.page.getByTestId("tabs").getByRole("link", { name, exact: true });
const offline = (on: boolean) => (on ? setOffline(app, true) : goOnline(app, async (p) => (await p.getByTestId("sync-chip").getAttribute("data-state")) === "online"));
const runs = () => app.page.evaluate(() => window.__ffmPlans!.renderRuns());
const attr = async (l: Locator, name: string) => Number(await l.getAttribute(name));
captureOnFailure(() => app);

test.beforeAll(async () => {
  await ensureOnline();
  await seedBuilding({ projectId: P, buildingId: B, name: "Plans Tower", pdf: readSample(SAMPLE_PDF) });
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
});

test("before the download the plan is listed but greyed out (not offline)", async () => {
  await tab("Plans").click();
  const row = app.page.getByTestId("plan-row").filter({ hasText: PLAN_NAME });
  await expect(row).toBeVisible({ timeout: 60_000 });
  await expect(row).toHaveAttribute("data-tile-state", "not-offline");
  await expect(row.getByTestId("plan-badge")).toHaveText("Not offline");
  await expect(row.getByTestId("plan-open")).toHaveCount(0);
  expect(await runs()).toBe(0);
});

test("make available offline: the tiles are rendered at download time and /offline shows it", async () => {
  await tab("More").click();
  await app.page.getByTestId("open-offline").click();
  // The emulator may report mobile data instead of Wi-Fi; the default Wi-Fi-only setting would (correctly) refuse.
  await expect(app.page.getByTestId("offline-net")).toContainText("Online", { timeout: 30_000 });
  if (!/wifi/i.test((await app.page.getByTestId("offline-net").textContent()) ?? "")) await app.page.getByTestId("wifi-only").uncheck();
  await app.page.getByTestId(`offline-start-${B}`).click();
  await expect(app.page.getByTestId(`offline-badge-${B}`)).toHaveAttribute("data-state", "ready", { timeout: 90_000 });
  const line = app.page.getByTestId(`offline-tiles-${VERSION}`);
  await expect(line).toHaveAttribute("data-tile-state", "ready", { timeout: 180_000 });
  await expect(line).toContainText("tiles: ready");
  expect(await app.page.evaluate((v) => window.__ffmPlans!.tileCount(v), VERSION)).toBeGreaterThan(10);
  expect(await runs()).toBe(1); // one render, triggered by the download hook
  await app.shot("plans-01-tiles-at-download");
});

test("the Plans tab shows the offline plan with ready tiles", async () => {
  await tab("Plans").click();
  const row = app.page.getByTestId("plan-row").filter({ hasText: PLAN_NAME });
  await expect(row.getByTestId("plan-badge")).toHaveText("Tiles ready", { timeout: 30_000 });
  await expect(row).toHaveAttribute("data-version-id", VERSION);
  await expect(row.getByTestId("plan-prepare")).toHaveCount(0);
});

test("airplane mode: the plan opens from the pre-rendered tiles, nothing is rendered on the spot", async () => {
  await offline(true);
  await expect(app.page.getByTestId("sync-chip")).toHaveAttribute("data-state", "offline", { timeout: 45_000 });
  const before = await runs();
  await app.page.getByTestId("plan-row").filter({ hasText: PLAN_NAME }).getByTestId("plan-open").click();
  const viewer = app.page.getByTestId("plan-viewer");
  await expect(viewer).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => attr(viewer, "data-drawn"), { timeout: 30_000 }).toBeGreaterThan(0);
  await expect(app.page.getByTestId("plan-preparing")).toHaveCount(0);
  expect(await runs()).toBe(before);
  await app.shot("plans-02-open-offline");
});

test("a task pinned on the plan while offline carries pdfVersionId, and it reaches Firestore", async () => {
  const viewer = app.page.getByTestId("plan-viewer");
  await app.page.getByTestId("plan-fit").click();
  await app.page.waitForTimeout(400);
  const b = (await viewer.boundingBox())!;
  await touch.longPress(b.x + b.width / 2 - 100, b.y + b.height / 2 + 30);
  await app.page.getByTestId("plan-new-task").click();
  await expect(app.page.getByTestId("task-form")).toBeVisible();
  expect(app.page.url()).toContain("anchor=plan~");
  await app.page.getByTestId("task-title").fill(TITLE);
  await app.page.getByTestId("task-submit").click();

  // back on the plan: the new pin belongs to the displayed revision (normal style)
  const pin = app.page.locator(`[data-testid="plan-pin"][aria-label$="${TITLE}"]`);
  await expect(pin).toHaveCount(1, { timeout: 30_000 });
  await expect(pin).toHaveAttribute("data-revision", "current");
  await expect(app.page.getByTestId("plan-preparing")).toHaveCount(0);

  await offline(false);
  await expect
    .poll(async () => (await listDocs(`projects/${P}/tasks`)).some((d) => d.data.title === TITLE), { timeout: 60_000, intervals: [1000] })
    .toBe(true);
  const doc = (await listDocs(`projects/${P}/tasks`)).find((d) => d.data.title === TITLE)!.data;
  const pdf = (doc.location as { pdf: Record<string, unknown> }).pdf;
  expect(pdf).toMatchObject({ pdfFileId: FILE, pdfVersionId: VERSION, page: 1, calibId: "uncalibrated" });
  expect(await runs()).toBe(1); // still no render since the download
});
