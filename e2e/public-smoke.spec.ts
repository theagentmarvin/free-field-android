// Public smoke lane: passes on the app-owned demo seed (apps/mobile/demo-seed) that ships with the repository, so a
// contributor without the maintainer data set can verify a build. Run it with:
//   FFM_FORCE_APP_SEED=1 pnpm e2e e2e/public-smoke.spec.ts
// The other specs are written against the larger maintainer data set (plan names such as P-101, MEP models) and need it.
import { expect, test } from "@playwright/test";
import { launchApp, type AppSession } from "./app";
import { gotoModel } from "./model";

test.describe.configure({ mode: "serial" });
test.setTimeout(240_000);

let app: AppSession;
const TITLE = "Smoke: check the slab edge at grid B";

test.beforeAll(async () => {
  app = await launchApp();
});
test.afterEach(async ({}, info) => {
  if (info.status !== info.expectedStatus) {
    console.log("PAGE ERRORS:", JSON.stringify(app.pageErrors.slice(-10)), "CONSOLE ERRORS:", JSON.stringify(app.consoleErrors.slice(-10)));
  }
});
test.afterAll(async () => {
  await app?.close();
});

const goTab = (name: string) => app.page.getByTestId("tabs").getByRole("link", { name, exact: true }).click();

test("sign in to the demo", async () => {
  await app.page.getByTestId("demo-signin").click();
  const picker = app.page.getByTestId("project-picker");
  const tabs = app.page.getByTestId("tabs");
  await expect(picker.or(tabs)).toBeVisible();
  if (await picker.isVisible()) await app.page.getByTestId("project-default-project").click();
  await expect(tabs).toBeVisible();
  await app.shot("smoke-01-shell");
});

test("the demo model loads", async () => {
  await gotoModel(app);
  await expect(app.page.getByTestId("model-route")).toHaveAttribute("data-building", /.+/);
  await app.page.waitForTimeout(2500); // tiles stream in
  await app.shot("smoke-02-model");
});

test("the generated floor plan opens and draws", async () => {
  await goTab("Plans");
  const row = app.page.getByTestId("plan-row").filter({ hasText: "S-101" });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.getByTestId("plan-open").click();
  const viewer = app.page.getByTestId("plan-viewer");
  await expect(viewer).toBeVisible({ timeout: 60_000 });
  await expect.poll(async () => Number(await viewer.getAttribute("data-drawn")), { timeout: 30_000 }).toBeGreaterThan(0);
  await app.shot("smoke-03-plan");
});

test("a task can be created and shows in the list", async () => {
  await goTab("Tasks");
  await expect(app.page.getByTestId("task-row").first()).toBeVisible({ timeout: 30_000 });
  await app.page.getByTestId("new-task").click();
  await app.page.getByTestId("task-title").fill(TITLE);
  await app.page.getByTestId("task-submit").click();
  await expect(app.page.getByTestId("detail-title")).toHaveText(TITLE, { timeout: 20_000 });
  await app.shot("smoke-04-task");
});
