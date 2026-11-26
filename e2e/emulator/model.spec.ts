import { expect, test } from "@playwright/test";
import { launchApp, PKG, type AppSession } from "../app";
import { dbg, expectGeometry, recordPerf, waitReady } from "../model";
import { appLinkFor, SEED, waitForSignInCode } from "./rest";
import { readSample, SAMPLE_FRAG, seedBuilding } from "./offlineSeed";
import { captureOnFailure, ensureOnline, restoreNetwork, setOffline } from "./network";

/**
 * Model tab against the Firebase emulators: the .frag is uploaded to Storage, downloaded through the offline
 * layer (native streaming plugin, sha256 verified) and then opened from disk by the viewer.
 */
test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);

const P = SEED.projects[0].id;
const withModel = { id: "b-model-tower", name: "Model Tower" };
const without = { id: "b-model-empty", name: "Model Empty" };
let app: AppSession;
captureOnFailure(() => app);

const tab = (name: string) => app.page.getByTestId("tabs").getByRole("link", { name, exact: true });
const picker = () => app.page.getByTestId("model-building-picker");

test.beforeAll(async () => {
  await ensureOnline();
  await seedBuilding({ projectId: P, buildingId: withModel.id, name: withModel.name, frag: readSample(SAMPLE_FRAG) });
  await seedBuilding({ projectId: P, buildingId: without.id, name: without.name });
  app = await launchApp();
});
test.afterAll(async () => {
  await restoreNetwork(app);
  await app?.close().catch(() => undefined);
});

test("a building that was not downloaded shows the offline prompt", async () => {
  await app.page.getByTestId("signin-email").fill(SEED.userMulti.email);
  await app.page.getByTestId("signin-submit").click();
  await expect(app.page.getByTestId("signin-sent")).toBeVisible();
  await app.shell(`am start -a android.intent.action.VIEW -p ${PKG} -d '${appLinkFor(await waitForSignInCode(SEED.userMulti.email))}'`);
  await app.page.getByTestId(`project-${P}`).click();
  await expect(app.page.getByTestId("tabs")).toBeVisible();

  await tab("Model").click();
  await expect(picker().locator(`option[value="${withModel.id}"]`)).toHaveCount(1, { timeout: 60_000 });
  await expect(picker().locator(`option[value="${without.id}"]`)).toHaveCount(1);
  await picker().selectOption(withModel.id);
  await expect(app.page.getByTestId("model-not-downloaded")).toBeVisible({ timeout: 30_000 }); // synced, not downloaded: never fetches on its own
  await expect(app.page.getByTestId("model-page")).toHaveCount(0);
  await app.shot("model-em-01-not-downloaded");
  await app.page.getByTestId("model-go-offline").click();
  await expect(app.page.getByTestId("offline-page")).toBeVisible();
});

test("download through the offline layer, then the model opens from disk", async () => {
  if (!/wifi/i.test((await app.page.getByTestId("offline-net").textContent()) ?? "")) await app.page.getByTestId("wifi-only").uncheck(); // emulator may report cellular after the cloud spec's airplane toggles
  await app.page.getByTestId(`offline-start-${withModel.id}`).click();
  await expect(app.page.getByTestId(`offline-badge-${withModel.id}`)).toHaveAttribute("data-state", "ready", { timeout: 90_000 });
  await tab("Model").click();
  await picker().selectOption(withModel.id);
  await waitReady(app.page);
  await expect(app.page.getByTestId("model-page")).toHaveAttribute("data-source", "downloaded");
  await app.page.waitForTimeout(2500);
  await expectGeometry(app, "model-em-02-downloaded");
  const st = await dbg(app.page, (d) => d.state());
  recordPerf({ downloadedModelViewerLoadMs: st.loadMs });
});

test("switching buildings disposes the previous model first (one at a time)", async () => {
  await picker().selectOption(without.id);
  await expect(app.page.getByTestId("model-not-downloaded")).toBeVisible({ timeout: 30_000 });
  await picker().selectOption(withModel.id);
  await waitReady(app.page);
  const reg = await dbg(app.page, (d) => d.registry());
  expect(reg.live).toBe(1);
  expect(reg.overlaps).toBe(0);
  expect(reg.acquired - reg.released).toBe(1);
});

test("airplane mode: the downloaded model opens with no network", async () => {
  await setOffline(app, true);
  await expect(app.page.getByTestId("sync-chip")).toHaveAttribute("data-state", "offline", { timeout: 45_000 });
  await tab("Tasks").click();
  await tab("Model").click();
  await waitReady(app.page);
  await app.page.waitForTimeout(2500);
  await expectGeometry(app, "model-em-03-offline");
});
