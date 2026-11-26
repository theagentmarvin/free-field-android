import { expect, test, type Locator } from "@playwright/test";
import { join } from "node:path";
import { launchApp, PKG, type AppSession } from "../app";
import { appLinkFor, SEED, waitForSignInCode } from "./rest";
import { readSample, seedBuilding } from "./offlineSeed";
import { captureOnFailure, ensureOnline, goOnline, restoreNetwork, setOffline } from "./network";


/**
 * Plan revisions in cloud mode, against the Firebase emulators: a plan with two revisions is made available offline,
 * and in airplane mode the older revision opens (tiles rendered on demand from the PDF the download verified) and
 * Compare runs. Every revision is part of the offline package, not just the latest.
 */
test.describe.configure({ mode: "serial" });
test.setTimeout(420_000);

const P = SEED.projects[0].id;
const B = "b-revs";
const FILE = `${B}-pdf`;
const V1 = `${B}-pv1`;
const V2 = `${B}-pv2`;
const PLAN_NAME = "Revisions Tower plan";
const SEEDPDF = join(process.cwd(), "vendor/free-field/apps/settings/public/seed/blobs/pdfBlobs");
const PLUMBING_1 = "bacaa023-e9d3-4f2d-8865-edc14b6c872e";
const PLUMBING_2 = "efdaecb9-9a69-464b-b4db-f8dae216778d";

let app: AppSession;

const tab = (name: string) => app.page.getByTestId("tabs").getByRole("link", { name, exact: true });
const offline = (on: boolean) => (on ? setOffline(app, true) : goOnline(app, async (p) => (await p.getByTestId("sync-chip").getAttribute("data-state")) === "online"));
const attr = async (l: Locator, name: string) => Number(await l.getAttribute(name));
captureOnFailure(() => app);

test.beforeAll(async () => {
  await ensureOnline();
  await seedBuilding({
    projectId: P,
    buildingId: B,
    name: "Revisions Tower",
    pdf: readSample(join(SEEDPDF, PLUMBING_2)),
    olderPdf: readSample(join(SEEDPDF, PLUMBING_1)),
    versionNumber: 2,
  });
  app = await launchApp();
});
test.afterAll(async () => {
  await restoreNetwork(app);
  await app?.close().catch(() => undefined);
});

test("sign in; the plan lists with two revisions before anything is downloaded", async () => {
  await app.page.getByTestId("signin-email").fill(SEED.userMulti.email);
  await app.page.getByTestId("signin-submit").click();
  await expect(app.page.getByTestId("signin-sent")).toBeVisible();
  await app.shell(`am start -a android.intent.action.VIEW -p ${PKG} -d '${appLinkFor(await waitForSignInCode(SEED.userMulti.email))}'`);
  await app.page.getByTestId(`project-${P}`).click();
  await expect(app.page.getByTestId("tabs")).toBeVisible();

  await tab("Plans").click();
  const row = app.page.getByTestId("plan-row").filter({ hasText: PLAN_NAME });
  await expect(row).toBeVisible({ timeout: 60_000 });
  await expect(row.getByTestId("plan-revisions-badge")).toHaveText("2 revisions");
});

test("make available offline downloads and verifies BOTH revisions", async () => {
  await tab("More").click();
  await app.page.getByTestId("open-offline").click();
  await expect(app.page.getByTestId("offline-net")).toContainText("Online", { timeout: 30_000 });
  if (!/wifi/i.test((await app.page.getByTestId("offline-net").textContent()) ?? "")) await app.page.getByTestId("wifi-only").uncheck();
  await app.page.getByTestId(`offline-start-${B}`).click();
  await expect(app.page.getByTestId(`offline-badge-${B}`)).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
  // the latest is tiled at download time, the older one only on demand
  await expect(app.page.getByTestId(`offline-tiles-${V2}`)).toHaveAttribute("data-tile-state", "ready", { timeout: 240_000 });
  const runs = await app.page.evaluate(() => window.__ffmPlans!.renderRuns());
  expect(runs).toBe(1);
});

test("airplane mode: every revision is listed on the device, the older one opens read-only and Compare runs", async () => {
  await tab("Plans").click();
  await offline(true);
  await expect(app.page.getByTestId("sync-chip")).toHaveAttribute("data-state", "offline", { timeout: 45_000 });
  await app.page.getByTestId("plan-row").filter({ hasText: PLAN_NAME }).getByTestId("plan-open").click();
  const viewer = app.page.getByTestId("plan-viewer");
  await expect(viewer).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => attr(viewer, "data-drawn"), { timeout: 60_000 }).toBeGreaterThan(0);
  await app.page.getByTestId("plan-revisions").click();
  const rows = app.page.getByTestId("revision-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toHaveAttribute("data-on-device", "1");
  await expect(rows.nth(1)).toHaveAttribute("data-on-device", "1");
  await expect(app.page.getByTestId("revision-not-on-device")).toHaveCount(0);

  await rows.nth(1).getByTestId("revision-open").click();
  await expect(app.page.getByTestId("revision-banner")).toContainText("Revision 1 of 2, not the latest", { timeout: 30_000 });
  await expect(app.page.getByTestId("plan-viewer")).toBeVisible({ timeout: 240_000 }); // tiles of this revision render on demand
  await expect.poll(() => attr(app.page.getByTestId("plan-viewer"), "data-drawn"), { timeout: 60_000 }).toBeGreaterThan(0);
  await app.shot("rev-cloud-01-old-revision-offline");

  await app.page.getByTestId("revision-banner-compare").click();
  await expect(app.page.getByTestId("compare-page")).toHaveAttribute("data-phase", "ready", { timeout: 420_000 });
  expect(Number(await app.page.getByTestId("compare-summary").getAttribute("data-changes"))).toBeGreaterThan(0);
  await app.shot("rev-cloud-02-compare-offline");
  await offline(false);
});
