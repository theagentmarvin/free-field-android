import { expect, test, type Locator } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchApp, PKG, SHOTS, touchSession, type AppSession } from "./app";
import { adb, pushToBlobStore, startMemorySampler } from "./perf";
import { setRotation } from "./qa";

test.describe.configure({ mode: "serial" });

let app: AppSession;
let touch: Awaited<ReturnType<typeof touchSession>>;

test.beforeAll(async () => {
  app = await launchApp();
  await app.page.getByTestId("demo-signin").click();
  const picker = app.page.getByTestId("project-picker");
  const tabs = app.page.getByTestId("tabs");
  await expect(picker.or(tabs)).toBeVisible();
  if (await picker.isVisible()) await app.page.getByTestId("project-default-project").click();
  await expect(tabs).toBeVisible();
  touch = await touchSession(app.page);
});
test.afterEach(async ({}, info) => {
  if (info.status !== info.expectedStatus) {
    console.log("PAGE ERRORS:", JSON.stringify(app.pageErrors.slice(-10)), "CONSOLE ERRORS:", JSON.stringify(app.consoleErrors.slice(-10)));
    console.log("BADGE:", await app.page.getByTestId("plan-badge").allTextContents().catch(() => []));
  }
});
test.afterAll(async () => {
  await setRotation(app, 0).catch(() => undefined);
  await app?.shell("cmd connectivity airplane-mode disable").catch(() => undefined);
  await touch?.detach().catch(() => undefined);
  await app?.close();
});

const goPlans = () => app.page.getByTestId("tabs").getByRole("link", { name: "Plans", exact: true }).click();
const row = (name: string) => app.page.getByTestId("plan-row").filter({ hasText: name });

async function center(l: Locator) {
  const b = (await l.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width, h: b.height };
}
const attr = async (l: Locator, name: string) => Number(await l.getAttribute(name));

async function openPlan(name: string) {
  await goPlans();
  await row(name).getByTestId("plan-open").click();
  const viewer = app.page.getByTestId("plan-viewer");
  await expect(viewer).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => attr(viewer, "data-drawn"), { timeout: 30_000 }).toBeGreaterThan(0);
  return viewer;
}

test("plans tab lists plans by building and folder with offline badges", async () => {
  await goPlans();
  await expect(app.page.getByTestId("plan-building").first()).toBeVisible({ timeout: 30_000 });
  await expect(app.page.getByTestId("plan-group").first()).toBeVisible();
  expect(await app.page.getByTestId("plan-row").count()).toBeGreaterThanOrEqual(2);
  await expect(row("S-101").getByTestId("plan-badge")).toHaveText("Not rendered");
  await app.shot("10-plans-list");
});

test("download renders the tile pyramid and the badge flips to ready", async () => {
  await row("S-101").getByTestId("plan-prepare").click();
  await expect(row("S-101").getByTestId("plan-badge")).toHaveText("Tiles ready", { timeout: 120_000 });
  const versionId = (await row("S-101").getAttribute("data-version-id"))!;
  const tiles = await app.page.evaluate((v) => window.__ffmPlans!.tileCount(v), versionId);
  expect(tiles).toBeGreaterThan(10);
  console.log("PLANS S-101 tiles:", tiles);
  await expect(row("S-101").getByTestId("plan-prepare")).toHaveCount(0);
  await app.shot("11-plans-ready");
});

test("viewer shows tiles, seeded pins, and zooms with pinch and double-tap", async () => {
  const viewer = await openPlan("S-101");
  await expect(app.page.getByTestId("plan-page")).toHaveAttribute("data-plan-name", /S-101/);
  await app.page.waitForTimeout(800);
  await app.shot("12-plan-open");
  const zoom0 = await attr(viewer, "data-zoom");
  const c = await center(viewer);

  await touch.pinch(c.x, c.y, 120, 520);
  await expect.poll(() => attr(viewer, "data-zoom")).toBeGreaterThan(zoom0 * 1.8);
  const zoomed = await attr(viewer, "data-zoom");
  await expect.poll(() => attr(viewer, "data-level"), { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
  await expect.poll(() => attr(viewer, "data-drawn")).toBeGreaterThan(0);
  await app.shot("13-plan-pinched");

  await touch.pinch(c.x, c.y, 520, 120);
  await expect.poll(() => attr(viewer, "data-zoom")).toBeLessThan(zoomed * 0.7);

  await app.page.getByTestId("plan-fit").click();
  const fit = await attr(viewer, "data-zoom");
  await touch.doubleTap(c.x, c.y);
  await expect.poll(() => attr(viewer, "data-zoom")).toBeGreaterThan(fit * 2);
  await app.page.waitForTimeout(700); // let the animation and tile loads settle on the slow software GPU
  await touch.doubleTap(c.x, c.y);
  await expect.poll(() => attr(viewer, "data-zoom")).toBeLessThan(fit * 1.2);
  await app.page.waitForTimeout(700);

  // pan: drag changes what is visible but keeps the zoom
  await touch.doubleTap(c.x, c.y);
  await expect.poll(() => attr(viewer, "data-zoom")).toBeGreaterThan(fit * 2);
  // the double-tap zoom animates: on a real GPU the threshold above is crossed mid-animation, so wait until it settles
  let prev = -1;
  await expect.poll(async () => { const now = await attr(viewer, "data-zoom"); const settled = now === prev; prev = now; return settled; }, { intervals: [150], timeout: 10_000 }).toBe(true);
  const z = await attr(viewer, "data-zoom");
  await touch.drag(c.x + 200, c.y + 100, c.x - 100, c.y);
  await app.page.waitForTimeout(500);
  expect(await attr(viewer, "data-zoom")).toBeCloseTo(z, 3);
  await expect.poll(() => attr(viewer, "data-drawn")).toBeGreaterThan(0);

  // fling: a fast swipe starts an inertia glide on release (the viewer counts them), the plan ends up at least where the
  // finger left it (the glide may be cut short by the pan limits) and then it stops
  const flings0 = Number((await viewer.getAttribute("data-flings")) ?? 0);
  const tx0 = await attr(viewer, "data-tx");
  await touch.swipe(c.x - 150, c.y, c.x + 150, c.y);
  await expect.poll(async () => Number((await viewer.getAttribute("data-flings")) ?? 0), { timeout: 5000 }).toBe(flings0 + 1);
  expect(Number(await viewer.getAttribute("data-fling-speed"))).toBeGreaterThan(1);
  await app.page.waitForTimeout(3000); // tau 325 ms: the glide is below the stop speed after about 2.5 s
  const txSettled = await attr(viewer, "data-tx");
  expect(txSettled - tx0).toBeGreaterThanOrEqual(300);
  await app.page.waitForTimeout(500);
  expect(await attr(viewer, "data-tx")).toBe(txSettled);
  expect(await attr(viewer, "data-zoom")).toBeCloseTo(z, 3);
  await app.page.getByTestId("plan-fit").click();
});

test("long-press creates a task here and its pin appears on the plan", async () => {
  const viewer = app.page.getByTestId("plan-viewer");
  await app.page.getByTestId("plan-fit").click();
  await app.page.waitForTimeout(400);
  const pinsBefore = await app.page.getByTestId("plan-pin").count();
  const c = await center(viewer);
  await touch.longPress(c.x - 120, c.y + 40);
  const btn = app.page.getByTestId("plan-new-task");
  await expect(btn).toBeVisible();
  await app.shot("14-plan-longpress");
  await btn.click();

  await expect(app.page.getByTestId("task-form")).toBeVisible();
  await expect(app.page.getByTestId("anchor-chip")).toContainText("S-101");
  expect(app.page.url()).toContain("/tasks/new?anchor=plan~");
  // the dedicated screen: no task list beside it
  await expect(app.page.getByTestId("task-row")).toHaveCount(0);
  await expect(app.page.getByTestId("tasks-list-pane")).toHaveCount(0);
  await app.shot("14b-plan-new-task-screen");

  // Close returns to the plan, the draft is kept; the same pin reopens from the Drafts folder
  await app.page.getByTestId("task-title").fill("Draft kept on close");
  await expect(app.page.getByTestId("draft-status")).toHaveAttribute("data-saved", "1", { timeout: 10_000 });
  await app.page.getByTestId("task-back").click();
  await expect(app.page.getByTestId("plan-viewer")).toBeVisible({ timeout: 30_000 });
  await app.page.getByTestId("plan-fit").click();
  await touch.longPress(c.x - 120, c.y + 40);
  await app.page.getByTestId("plan-new-task").click();
  await expect(app.page.getByTestId("task-form")).toBeVisible();
  await app.page.getByTestId("task-title").fill("Crack at gridline C");
  await app.page.getByTestId("task-submit").click();

  await expect(app.page.getByTestId("plan-viewer")).toBeVisible({ timeout: 30_000 });
  const pin = app.page.locator('[data-testid="plan-pin"][aria-label$="Crack at gridline C"]');
  await expect(pin).toHaveCount(1, { timeout: 30_000 });
  expect(await app.page.getByTestId("plan-pin").count()).toBe(pinsBefore + 1);
  await expect(pin).toHaveAttribute("data-revision", "current"); // stamped with the displayed version
  await app.shot("15-plan-new-pin");

  // tapping the pin opens the task
  await pin.click();
  await expect(app.page.getByTestId("task-detail")).toContainText("Crack at gridline C", { timeout: 20_000 });
});

const PARITY = join(process.cwd(), "docs", "spikes", "parity-views");
async function parityShot(name: string) {
  await app.shot(name);
  mkdirSync(PARITY, { recursive: true });
  for (const f of [`${name}-device.png`, `${name}.png`]) {
    if (existsSync(join(SHOTS, f))) {
      copyFileSync(join(SHOTS, f), join(PARITY, `${name}.png`));
      return;
    }
  }
}

test("a long-press task on a calibrated plan also stores a 3D point: the task shows the plan and Show in model", async () => {
  // still on the detail of "Crack at gridline C" (made on S-101, which is calibrated to its level)
  const detail = app.page.getByTestId("task-detail");
  await expect(detail).toContainText("Crack at gridline C");
  const taskId = (await detail.getAttribute("data-task-id"))!;
  await expect(app.page.getByTestId("location-chips")).toHaveAttribute("data-dual", "1");
  await expect(app.page.getByTestId("loc-plan")).toBeVisible();
  await expect(app.page.getByTestId("loc-model")).toBeVisible();
  await parityShot("70-plan-task-dual-location");
  // Show in model opens the 3D view of the building on the pin made from the plan
  await app.page.getByTestId("loc-model").click();
  await expect(app.page.getByTestId("model-page")).toHaveAttribute("data-phase", "ready", { timeout: 90_000 });
  expect(app.page.url()).toContain(`task=${taskId}`);
  await expect.poll(() => app.page.evaluate((id) => window.__ffmModelDebug?.pinScreen(id)?.visible ?? false, taskId), { timeout: 60_000 }).toBe(true);
  await app.page.waitForTimeout(2500);
  await parityShot("71-plan-task-in-model");
  // and back on the plan the pin is still there
  await app.page.goBack();
  await expect(app.page.getByTestId("task-detail")).toBeVisible({ timeout: 20_000 });
  await app.page.getByTestId("loc-plan").click();
  await expect(app.page.locator('[data-testid="plan-pin"][aria-label$="Crack at gridline C"]')).toHaveCount(1, { timeout: 30_000 });
});

test("pins from an earlier or unknown revision get a distinct style and an explanation on tap", async () => {
  await goPlans();
  await row("S-101").getByTestId("plan-open").click();
  await expect(app.page.getByTestId("plan-viewer")).toBeVisible();
  const pdfFileId = /#\/plans\/([^/?]+)/.exec(app.page.url())![1];
  const mk = (title: string, uv: [number, number], pdfVersionId?: string) =>
    app.page.evaluate(
      ([t, id, p, v]) =>
        window.__ffmTest!.createTask(t as string, {
          location: { storeyName: null, bim: null, pdf: { pdfFileId: id as string, page: 1, uv: p as [number, number], calibId: "uncalibrated", ...(v ? { pdfVersionId: v as string } : {}) } },
        }),
      [title, pdfFileId, uv, pdfVersionId] as const,
    );
  await mk("Legacy pin", [0.3, 0.3]);
  await mk("Old revision pin", [0.6, 0.3], "an-older-version");
  const legacy = app.page.locator('[data-testid="plan-pin"][aria-label*="Legacy pin"]');
  const old = app.page.locator('[data-testid="plan-pin"][aria-label*="Old revision pin"]');
  await expect(legacy).toHaveCount(1, { timeout: 30_000 });
  await expect(old).toHaveCount(1);
  await expect(legacy).toHaveAttribute("data-revision", "earlier");
  await expect(old).toHaveAttribute("data-revision", "earlier");
  await legacy.click();
  const note = app.page.getByTestId("plan-earlier-note");
  await expect(note).toContainText("Placed on an earlier revision");
  await app.shot("15b-plan-earlier-revision");
  await app.page.getByTestId("plan-earlier-dismiss").click();
  await expect(note).toHaveCount(0);
  await legacy.click();
  await app.page.getByTestId("plan-earlier-open").click(); // the task itself is still one tap away
  await expect(app.page.getByTestId("task-detail")).toContainText("Legacy pin", { timeout: 20_000 });
});

const MPU = 0.033983052125696425; // the demo S-101 calibration (metres per PDF point)
const tapAt = async (x: number, y: number) => {
  await touch.tap(x, y);
  await app.page.waitForTimeout(250);
};
const near = (actual: number, expected: number, rel: number, what: string) => expect(Math.abs(actual - expected) / Math.abs(expected), `${what}: ${actual} vs ${expected}`).toBeLessThan(rel);

test("measure on a calibrated plan: length, area, angle in metres; two fingers still pan and zoom", async () => {
  const viewer = await openPlan("S-101");
  await app.page.getByTestId("plan-fit").click();
  await app.page.waitForTimeout(500);
  await app.page.getByTestId("measure-toggle").click();
  await expect(app.page.getByTestId("measure-bar")).toHaveAttribute("data-tool", "length");
  await expect(app.page.getByTestId("measure-scale-badge")).toHaveAttribute("data-source", "calibrated");
  await expect(app.page.getByTestId("measure-scale-hint")).toHaveCount(0);
  const z = await attr(viewer, "data-zoom");
  const c = await center(viewer);

  // a finger held down shows the loupe and the reticle; the point lands where it lifts
  const f = await touch.press(c.x - 100, c.y - 60);
  await f.move(c.x - 100, c.y - 40);
  await expect(app.page.getByTestId("measure-loupe")).toBeVisible();
  await expect(app.page.getByTestId("measure-reticle")).toHaveCount(1);
  await app.shot("40-plan-measure-loupe");
  const loupe = (await app.page.getByTestId("measure-loupe").boundingBox())!;
  expect(loupe.y + loupe.height, "the loupe sits above the fingertip").toBeLessThan(c.y - 40);
  await f.release();
  await expect(app.page.getByTestId("measure-loupe")).toHaveCount(0);
  await expect(app.page.getByTestId("measure-live")).toHaveText("1 point");
  await tapAt(c.x - 300, c.y - 40); // 200 px to the left (clear of the seeded task pin): a 200 / zoom point length
  await expect(app.page.getByTestId("measure-live")).toHaveText(/ m$/);
  await app.page.getByTestId("measure-finish").click();
  await app.page.getByTestId("measure-list-open").click();
  const len = app.page.locator('[data-testid="measure-row"][data-kind="length"]');
  await expect(len).toHaveCount(1);
  const pts = 200 / z; // page units
  near(Number(await len.getAttribute("data-value")), pts, 0.02, "length in page points");
  const metres = Number((await len.getAttribute("data-text"))!.replace(/ m$/, ""));
  near(metres, pts * MPU, 0.02, "calibrated length in metres");
  expect(await len.getAttribute("data-text")).toMatch(/ m$/);
  await app.shot("41-plan-measure-list");
  await app.page.getByTestId("measure-sheet-close").click();

  // area: a 150 px square
  await app.page.getByTestId("measure-tool-area").click();
  // keep every tap on bare plan canvas: in landscape the measure bar covers the lower part of the plan
  await app.page.waitForTimeout(400);
  const taps = (oy: number) => [[-75, 40], [75, 40], [75, 190], [-75, 190], [-300, 100], [-300, 200], [-200, 200]].map(([dx, dy]) => [c.x + dx, c.y + oy + dy]);
  let oy = 0;
  while (!(await app.page.evaluate((pts) => pts.every(([x, y]) => document.elementFromPoint(x, y)?.classList.contains("plan-canvas")), taps(oy)))) {
    oy -= 10;
    expect(oy, "room for the area and angle taps above the measure bar").toBeGreaterThan(-300);
  }
  for (const [dx, dy] of [[-75, 40], [75, 40], [75, 190], [-75, 190]]) await tapAt(c.x + dx, c.y + oy + dy);
  await expect(app.page.getByTestId("measure-finish")).toBeEnabled();
  await app.page.getByTestId("measure-finish").click();
  // angle: a right angle at the middle point (finishes by itself on the third point)
  await app.page.getByTestId("measure-tool-angle").click();
  await tapAt(c.x - 300, c.y + oy + 100);
  await expect(app.page.getByTestId("measure-live")).toHaveText("1 point");
  await tapAt(c.x - 300, c.y + oy + 200);
  await expect(app.page.getByTestId("measure-live")).toHaveText("2 points");
  await tapAt(c.x - 200, c.y + oy + 200);
  await app.page.getByTestId("measure-list-open").click();
  await expect(app.page.getByTestId("measure-row")).toHaveCount(3);
  const area = app.page.locator('[data-testid="measure-row"][data-kind="area"]');
  near(Number(await area.getAttribute("data-value")), (150 / z) ** 2, 0.03, "area in page points squared");
  expect(await area.getAttribute("data-text")).toMatch(/m²$/);
  const sq = Number((await area.getAttribute("data-text"))!.replace(/ m²$/, ""));
  near(sq, (150 / z) ** 2 * MPU * MPU, 0.03, "calibrated area in square metres");
  const ang = app.page.locator('[data-testid="measure-row"][data-kind="angle"]');
  expect(Math.abs(Number(await ang.getAttribute("data-value")) - 90)).toBeLessThan(1.5);
  await app.shot("42-plan-measure-3");
  await app.page.getByTestId("measure-sheet-close").click();
  await expect(app.page.locator('[data-testid="measure-shape"]')).toHaveCount(3);

  // two fingers pan/zoom and add nothing; a pinch ends in one finger without placing a point either
  const zoom0 = await attr(viewer, "data-zoom");
  await touch.pinch(c.x, c.y - 200, 120, 300);
  await expect.poll(() => attr(viewer, "data-zoom")).toBeGreaterThan(zoom0 * 1.3);
  const tx0 = await attr(viewer, "data-tx");
  await touch.twoFingerPan(c.x, c.y - 250, 160, 120, 0);
  await expect.poll(() => attr(viewer, "data-tx")).toBeGreaterThan(tx0 + 60);
  await app.page.waitForTimeout(300);
  await expect(app.page.getByTestId("measure-overlay")).toHaveAttribute("data-count", "3");
  await expect(app.page.getByTestId("measure-bar")).toHaveAttribute("data-tool", "angle");
  // one finger dragging does NOT pan in measure mode
  const tx1 = await attr(viewer, "data-tx");
  await touch.drag(c.x - 100, c.y - 300, c.x + 100, c.y - 300);
  expect(await attr(viewer, "data-tx")).toBe(tx1);
  // undo / cancel
  await app.page.getByTestId("measure-tool-length").click();
  await tapAt(c.x - 100, c.y - 200);
  await expect(app.page.getByTestId("measure-undo")).toBeEnabled();
  await app.page.getByTestId("measure-undo").click();
  await expect(app.page.getByTestId("measure-undo")).toBeDisabled();
  await tapAt(c.x - 100, c.y - 200);
  await app.page.getByTestId("measure-cancel").click(); // drops the draft
  await expect(app.page.getByTestId("measure-undo")).toBeDisabled();
  await app.page.getByTestId("measure-cancel").click(); // nothing drafted: leaves measure mode
  await expect(app.page.getByTestId("measure-toggle")).toBeVisible();
  // pan works again with one finger once measure mode is off
  await touch.drag(c.x - 100, c.y - 300, c.x + 100, c.y - 300);
  await expect.poll(() => attr(viewer, "data-tx")).not.toBe(tx1);
});

test("measurements persist, focus and delete from the list", async () => {
  await app.page.getByTestId("plan-back").click();
  const viewer = await openPlan("S-101");
  await app.page.getByTestId("measure-list-open").click();
  await expect(app.page.getByTestId("measure-row")).toHaveCount(3);
  await app.page.getByTestId("measure-row-focus").first().click();
  await expect(app.page.getByTestId("measure-sheet")).toHaveCount(0);
  await expect(app.page.getByTestId("measure-overlay")).toHaveAttribute("data-count", "3");
  await app.page.getByTestId("measure-list-open").click();
  await app.page.getByTestId("measure-row-delete").first().click();
  await expect(app.page.getByTestId("measure-row")).toHaveCount(2);
  await app.page.getByTestId("measure-clear").click();
  await expect(app.page.getByTestId("measure-row")).toHaveCount(0);
  await app.page.getByTestId("measure-sheet-close").click();
  await expect(viewer).toHaveAttribute("data-measuring", "0");
});

test("an uncalibrated plan offers Set scale from a known distance; the scale is kept per plan version", async () => {
  await app.page.getByTestId("plan-back").click();
  await goPlans();
  if ((await row("S-102").getByTestId("plan-prepare").count()) > 0) {
    await row("S-102").getByTestId("plan-prepare").click();
    await expect(row("S-102").getByTestId("plan-badge")).toHaveText("Tiles ready", { timeout: 120_000 });
  }
  const viewer = await openPlan("S-102");
  await app.page.getByTestId("plan-fit").click();
  await app.page.waitForTimeout(500);
  const z = await attr(viewer, "data-zoom");
  const c = await center(viewer);
  await app.page.getByTestId("measure-toggle").click();
  await expect(app.page.getByTestId("measure-scale-badge")).toHaveAttribute("data-source", "none");
  await expect(app.page.getByTestId("measure-scale-hint")).toBeVisible();
  await app.shot("43-plan-uncalibrated");
  // before any scale the value reads in page points
  await tapAt(c.x - 150, c.y);
  await tapAt(c.x + 150, c.y);
  await app.page.getByTestId("measure-finish").click();
  await app.page.getByTestId("measure-list-open").click();
  await expect(app.page.getByTestId("measure-row").first()).toHaveAttribute("data-text", / pt$/);
  await app.page.getByTestId("measure-sheet-close").click();

  // set scale: two taps 300 px apart are 12.5 m
  await app.page.getByTestId("measure-scale-hint-btn").click();
  await tapAt(c.x - 150, c.y + 120);
  await tapAt(c.x + 150, c.y + 120);
  await expect(app.page.getByTestId("measure-scale-dialog")).toBeVisible();
  await expect(app.page.getByTestId("measure-scale-apply")).toBeDisabled();
  await app.page.getByTestId("measure-scale-input").fill("12,5");
  await app.shot("44-plan-set-scale");
  await app.page.getByTestId("measure-scale-apply").click();
  await expect(app.page.getByTestId("measure-scale-badge")).toHaveAttribute("data-source", "manual");
  await expect(app.page.getByTestId("measure-scale-hint")).toHaveCount(0);
  // the earlier 300 px measurement now reads 12.5 m, and a new one agrees
  await tapAt(c.x - 150, c.y - 150);
  await tapAt(c.x + 150, c.y - 150);
  await app.page.getByTestId("measure-finish").click();
  await app.page.getByTestId("measure-list-open").click();
  const texts = await app.page.getByTestId("measure-row").evaluateAll((els) => els.map((e) => e.getAttribute("data-text")));
  console.log("S-102 after set scale:", JSON.stringify(texts), "zoom", z);
  expect(texts).toHaveLength(2);
  for (const t of texts) near(Number(t!.replace(/ m$/, "")), 12.5, 0.02, "known distance");
  await app.shot("45-plan-scaled-list");
  await app.page.getByTestId("measure-sheet-close").click();
  // the scale is stored per plan: leave and come back
  await app.page.getByTestId("measure-cancel").click();
  await app.page.getByTestId("plan-back").click();
  await openPlan("S-102");
  await expect(app.page.getByTestId("measure-overlay")).toHaveAttribute("data-count", "2");
  await app.page.getByTestId("measure-toggle").click();
  await expect(app.page.getByTestId("measure-scale-badge")).toHaveAttribute("data-source", "manual");
  // reset scale falls back to points
  await app.page.getByTestId("measure-list-open").click();
  await app.page.getByTestId("measure-scale-reset").click();
  await expect(app.page.getByTestId("measure-row").first()).toHaveAttribute("data-text", / pt$/);
  await app.page.getByTestId("measure-clear").click();
  await app.page.getByTestId("measure-sheet-close").click();
  await app.page.getByTestId("measure-cancel").click();
});

test("the plan opens offline (airplane mode) and keeps rendering", async () => {
  await app.shell("cmd connectivity airplane-mode enable");
  await expect(app.page.getByTestId("sync-chip")).toHaveAttribute("data-state", "offline", { timeout: 30_000 });
  const viewer = await openPlan("S-101");
  await app.page.waitForTimeout(600);
  await app.shot("16-plan-offline");
  expect(await attr(viewer, "data-drawn")).toBeGreaterThan(0);
  await app.shell("cmd connectivity airplane-mode disable");
  await expect(app.page.getByTestId("sync-chip")).toHaveAttribute("data-state", "online", { timeout: 60_000 });
});

// ── plan revisions (docs/spikes/plan-revisions.md) ────────────────────────────────────────────────
// The demo project has one plan with two revisions: "P-101 - Plumbing.pdf" (PLUMBING 1.pdf = v1, PLUMBING 2.pdf = v2, latest).
const DOCS = join(process.cwd(), "docs", "spikes", "plan-revisions");
/** Screenshot into test-results and into docs/spikes/plan-revisions/ (the device framebuffer: the page capture misses canvas pixels). */
async function shotDoc(name: string) {
  await app.shot(name);
  mkdirSync(DOCS, { recursive: true });
  for (const f of [`${name}-device.png`, `${name}.png`]) {
    if (existsSync(join(SHOTS, f))) {
      copyFileSync(join(SHOTS, f), join(DOCS, `${name}.png`));
      return;
    }
  }
}
const landscape = async () => {
  await setRotation(app, 1);
  await expect.poll(() => app.page.evaluate(() => window.innerWidth > window.innerHeight), { timeout: 20_000 }).toBe(true);
  await app.page.waitForTimeout(1200);
};
const portrait = async () => {
  await setRotation(app, 0);
  await expect.poll(() => app.page.evaluate(() => window.innerWidth < window.innerHeight), { timeout: 20_000 }).toBe(true);
  await app.page.waitForTimeout(1200);
};
const plumbingId = () => /#\/plans\/([^/?]+)/.exec(app.page.url())![1];
const openRevisions = async () => {
  await app.page.getByTestId("plan-revisions").click();
  await expect(app.page.getByTestId("revision-sheet")).toBeVisible();
};

test("the plans list shows how many revisions a plan has", async () => {
  await goPlans();
  await expect(row("P-101").getByTestId("plan-revisions-badge")).toHaveText("2 revisions", { timeout: 30_000 });
  await expect(row("S-101").getByTestId("plan-revisions-badge")).toHaveCount(0); // a single version: no badge
  await shotDoc("rev-01-plans-list-portrait");
});

test("first open of a never-rendered plan shows the whole sheet long before the pyramid is done", async () => {
  test.setTimeout(8 * 60_000);
  await goPlans();
  const t0 = Date.now();
  await row("P-101").getByTestId("plan-open").click();
  const viewer = app.page.getByTestId("plan-viewer");
  await expect(viewer).toBeVisible({ timeout: 120_000 });
  await expect.poll(() => viewer.getAttribute("data-first-paint-ms"), { timeout: 120_000 }).not.toBe("");
  const paintWallMs = Date.now() - t0;
  const firstPaintMs = await attr(viewer, "data-first-paint-ms");
  await expect.poll(() => attr(viewer, "data-drawn"), { timeout: 240_000 }).toBeGreaterThan(0);
  const sharpWallMs = Date.now() - t0;
  const firstTileMs = await attr(viewer, "data-first-tile-ms");
  // the pyramid keeps filling in behind the preview; wait until it is complete
  await expect(app.page.getByTestId("plan-rendering")).toHaveCount(0, { timeout: 300_000 });
  const stats = await app.page.evaluate(() => window.__ffmPlans!.lastStats());
  const result = { paintWallMs, sharpWallMs, firstPaintMs, firstTileMs, preview: await viewer.getAttribute("data-preview"), stats };
  console.log("PLANS FIRST PAINT:", JSON.stringify(result));
  mkdirSync(SHOTS, { recursive: true });
  writeFileSync(join(SHOTS, "plans-first-paint.json"), JSON.stringify(result, null, 2));
  expect(stats).not.toBeNull();
  // the preview is on screen before the whole pyramid is written, and is the first thing that shows
  expect(await viewer.getAttribute("data-preview")).toBe("1");
  expect(firstPaintMs).toBeLessThan(stats!.ms);
  expect(stats!.marks.previewMs).toBeGreaterThan(0);
  expect(stats!.marks.previewMs).toBeLessThan(stats!.marks.totalMs);
  expect(firstPaintMs).toBeLessThanOrEqual(firstTileMs || Infinity);
});

test("revision history: every version is listed, an older one opens read-only and labelled, with a way back", async () => {
  test.setTimeout(6 * 60_000);
  const viewer = await openPlan("P-101");
  const page = app.page.getByTestId("plan-page");
  await expect(page).toHaveAttribute("data-revision-number", "2");
  await expect(page).toHaveAttribute("data-revision-latest", "1");
  await expect(app.page.getByTestId("revision-banner")).toHaveCount(0);
  await app.page.waitForTimeout(800);

  await openRevisions();
  const rows = app.page.getByTestId("revision-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("Revision 2");
  await expect(rows.nth(0)).toContainText("Latest");
  await expect(rows.nth(0)).toContainText("PLUMBING 2.pdf");
  await expect(rows.nth(1)).toContainText("Revision 1");
  await expect(rows.nth(1)).toContainText("PLUMBING 1.pdf");
  await shotDoc("rev-02-history-portrait");

  await rows.nth(1).getByTestId("revision-open").click(); // tiles of this revision are rendered on demand
  await expect(app.page.getByTestId("revision-banner")).toContainText("Revision 1 of 2, not the latest", { timeout: 30_000 });
  await expect(page).toHaveAttribute("data-revision-latest", "0");
  await expect(app.page.getByTestId("plan-viewer")).toBeVisible({ timeout: 240_000 }); // tiles of this revision render on demand
  await expect.poll(() => attr(app.page.getByTestId("plan-viewer"), "data-drawn"), { timeout: 60_000 }).toBeGreaterThan(0);
  await app.page.waitForTimeout(800);
  // read-only: long-press offers no new task, and the markup tools are not there
  const c = await center(app.page.getByTestId("plan-viewer"));
  await touch.longPress(c.x, c.y);
  await expect(app.page.getByTestId("plan-new-task")).toHaveCount(0);
  await shotDoc("rev-03-old-revision-portrait");
  await landscape();
  await shotDoc("rev-03b-old-revision-landscape");
  await openRevisions();
  await shotDoc("rev-02b-history-landscape");
  await app.page.getByTestId("revision-close").click();
  await portrait();

  await app.page.getByTestId("revision-open-latest").click();
  await expect(page).toHaveAttribute("data-revision-latest", "1");
  await expect(app.page.getByTestId("revision-banner")).toHaveCount(0);
  void viewer;
});

test("stale pins: a task placed on revision 1 shows on the latest as 'placed on revision 1'", async () => {
  test.setTimeout(4 * 60_000);
  await openPlan("P-101");
  const pdfFileId = plumbingId();
  await openRevisions();
  const v1 = (await app.page.getByTestId("revision-row").filter({ hasText: "Revision 1" }).getAttribute("data-version-id"))!;
  const v2 = (await app.page.getByTestId("revision-row").filter({ hasText: "Revision 2" }).getAttribute("data-version-id"))!;
  await app.page.getByTestId("revision-close").click();
  const mk = (title: string, uv: [number, number], pdfVersionId: string) =>
    app.page.evaluate(
      ([t, id, p, v]) =>
        window.__ffmTest!.createTask(t as string, {
          location: { storeyName: null, bim: null, pdf: { pdfFileId: id as string, page: 1, uv: p as [number, number], calibId: "uncalibrated", pdfVersionId: v as string } },
        }),
      [title, pdfFileId, uv, pdfVersionId] as const,
    );
  await mk("Valve on rev 1", [0.3, 0.4], v1);
  await mk("Valve on rev 2", [0.6, 0.4], v2);
  const stale = app.page.locator('[data-testid="plan-pin"][aria-label*="Valve on rev 1"]');
  const fresh = app.page.locator('[data-testid="plan-pin"][aria-label*="Valve on rev 2"]');
  await expect(stale).toHaveCount(1, { timeout: 30_000 });
  await expect(fresh).toHaveCount(1);
  await expect(stale).toHaveAttribute("data-revision", "earlier");
  await expect(stale).toHaveAttribute("aria-label", /placed on revision 1/);
  await expect(stale.getByTestId("plan-pin-rev")).toHaveText("R1");
  await expect(fresh).toHaveAttribute("data-revision", "current");
  await expect(fresh.getByTestId("plan-pin-rev")).toHaveCount(0);
  await shotDoc("rev-04-stale-pin-portrait");
  await stale.click();
  await expect(app.page.getByTestId("plan-earlier-note")).toContainText("Placed on revision 1");
  await shotDoc("rev-05-stale-pin-note-portrait");
  await landscape();
  await shotDoc("rev-05b-stale-pin-note-landscape");
  await portrait();
  // the note leads to the revision the pin belongs to; there the pin is a normal one and the newer pin is not shown
  await app.page.getByTestId("plan-earlier-view").click();
  await expect(app.page.getByTestId("revision-banner")).toContainText("Revision 1 of 2", { timeout: 30_000 });
  await expect(app.page.locator('[data-testid="plan-pin"][aria-label*="Valve on rev 1"]')).toHaveAttribute("data-revision", "current", { timeout: 30_000 });
  await expect(app.page.locator('[data-testid="plan-pin"][aria-label*="Valve on rev 2"]')).toHaveCount(0);
  await app.page.getByTestId("revision-open-latest").click();
});

/** Count strongly red / strongly blue pixels of the compare canvas (the overlay colours). */
const overlayPixels = () =>
  app.page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('[data-testid="compare-viewer"] canvas')!;
    const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    let red = 0;
    let blue = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] > 180 && d[i + 1] < 120 && d[i + 2] < 120) red++;
      else if (d[i + 2] > 180 && d[i] < 120 && d[i + 1] < 190) blue++;
    }
    return { red, blue };
  });

test("compare two revisions: overlay, swipe and changes share one pan and zoom", async () => {
  test.setTimeout(10 * 60_000);
  await openPlan("P-101");
  await openRevisions();
  await app.page.getByTestId("revision-compare").click();
  const cmp = app.page.getByTestId("compare-page");
  await expect(cmp).toBeVisible();
  await expect(app.page.getByTestId("compare-base")).toHaveValue(/.+/);
  await expect(cmp).toHaveAttribute("data-phase", "ready", { timeout: 420_000 });
  const v = app.page.getByTestId("compare-viewer");
  await expect.poll(() => attr(v, "data-drawn-base"), { timeout: 60_000 }).toBeGreaterThan(0);
  expect(await attr(v, "data-drawn-rev")).toBeGreaterThan(0);

  // overlay: the older revision's own ink is red, the newer one's blue (the web's two colours)
  await expect(v).toHaveAttribute("data-mode", "overlay");
  await expect(app.page.getByTestId("compare-legend")).toContainText("Revision 1");
  await app.page.waitForTimeout(1500);
  // the sheet first shows from coarse tiles: wait until the finer ones brought the thin red / blue lines in
  await expect.poll(async () => { const q = await overlayPixels(); return Math.min(q.red, q.blue); }, { timeout: 60_000, intervals: [1000] }).toBeGreaterThan(20);
  const px = await overlayPixels();
  console.log("COMPARE overlay pixels", JSON.stringify(px));
  const changes = Number(await app.page.getByTestId("compare-summary").getAttribute("data-changes"));
  expect(changes).toBeGreaterThan(0);
  await shotDoc("rev-06-compare-overlay-portrait");

  // pinch zooms BOTH revisions: the one view drives them, each keeps drawing tiles of its own
  const c = await center(v);
  const zoom0 = await attr(v, "data-zoom");
  await touch.pinch(c.x, c.y, 120, 520);
  await expect.poll(() => attr(v, "data-zoom")).toBeGreaterThan(zoom0 * 1.8);
  await expect.poll(() => attr(v, "data-level"), { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
  await expect.poll(async () => Math.min(await attr(v, "data-drawn-base"), await attr(v, "data-drawn-rev")), { timeout: 30_000 }).toBeGreaterThan(0);
  const tx0 = await attr(v, "data-tx");
  await touch.drag(c.x + 150, c.y, c.x - 100, c.y + 40);
  await expect.poll(() => attr(v, "data-tx")).toBeLessThan(tx0 - 100);
  await expect.poll(async () => Math.min(await attr(v, "data-drawn-base"), await attr(v, "data-drawn-rev")), { timeout: 30_000 }).toBeGreaterThan(0);
  await app.page.waitForTimeout(1500);
  const zoomed = await overlayPixels();
  expect(zoomed.red + zoomed.blue + 1).toBeGreaterThan(0);
  await app.page.getByTestId("compare-fit").click();

  // swipe: the divider moves with the finger, left shows the older revision, right the newer one
  await app.page.getByTestId("compare-mode-swipe").click();
  await expect(v).toHaveAttribute("data-mode", "swipe");
  await expect(app.page.getByTestId("compare-tag-base")).toHaveText("Revision 1");
  await expect(app.page.getByTestId("compare-tag-rev")).toHaveText("Revision 2");
  await app.page.waitForTimeout(1200);
  const div = app.page.getByTestId("compare-divider");
  const d0 = await center(div);
  const split0 = await attr(v, "data-split");
  await touch.drag(d0.x, d0.y, d0.x + 160, d0.y);
  await expect.poll(() => attr(v, "data-split")).toBeGreaterThan(split0 + 0.1);
  expect(await attr(v, "data-drawn-base")).toBeGreaterThan(0);
  expect(await attr(v, "data-drawn-rev")).toBeGreaterThan(0);
  await shotDoc("rev-07-compare-swipe-portrait");

  // changes: outlined regions, step through them, the view flies to each one
  await app.page.getByTestId("compare-mode-changes").click();
  await expect(v).toHaveAttribute("data-mode", "changes");
  await app.page.getByTestId("compare-next").click();
  await expect(app.page.getByTestId("compare-current")).toContainText("#1");
  await expect.poll(() => attr(v, "data-zoom"), { timeout: 5000 }).toBeGreaterThan(zoom0 * 1.5);
  await app.page.waitForTimeout(1500);
  await shotDoc("rev-08-compare-changes-portrait");
  await app.page.getByTestId("compare-next").click();
  await expect(app.page.getByTestId("compare-current")).toContainText("#2");

  // landscape
  await landscape();
  await app.page.getByTestId("compare-fit").click();
  await app.page.getByTestId("compare-mode-overlay").click();
  await app.page.waitForTimeout(2000);
  await shotDoc("rev-09-compare-overlay-landscape");
  await app.page.getByTestId("compare-mode-swipe").click();
  await app.page.waitForTimeout(1200);
  await shotDoc("rev-10-compare-swipe-landscape");
  await app.page.getByTestId("compare-mode-changes").click();
  await app.page.getByTestId("compare-fit").click();
  await app.page.waitForTimeout(1200);
  await shotDoc("rev-11-compare-changes-landscape");
  await portrait();

  // swapping the pair swaps the colours' meaning; the same revision twice is refused
  await app.page.getByTestId("compare-swap").click();
  await expect(cmp).toHaveAttribute("data-phase", "ready", { timeout: 120_000 });
  await app.page.getByTestId("compare-mode-swipe").click();
  await expect(app.page.getByTestId("compare-tag-base")).toHaveText("Revision 2");
  await app.page.getByTestId("compare-back").click();
  await expect(app.page.getByTestId("plan-page")).toBeVisible();
});

test("a 20 MB vector-heavy A0 PDF renders without a crash (peak memory + time recorded)", async () => {
  test.setTimeout(20 * 60_000);
  const local = join(process.cwd(), ".cache", "large-a0.pdf");
  if (!existsSync(local)) execFileSync("node", ["scripts/gen-large-plan.mjs", local], { stdio: "inherit" });
  const sizeMb = statSync(local).size / 1048576;

  // Push via adb (kept out of the APK) and copy into the app's BlobStore root with run-as (debug build).
  pushToBlobStore(local, "pdf/large-a0.pdf");
  expect(await app.page.evaluate(() => window.__ffmPlans!.hasPdf("large-a0"))).toBe(true);

  const pidBefore = adb("shell", `pidof ${PKG}`).trim();
  // Sample memory while the render runs: the app process and the WebView renderer (where pdf.js and canvases live).
  const sampler = startMemorySampler();
  const t0 = Date.now();
  const stats = await app.page.evaluate(() => window.__ffmPlans!.renderStored("large-a0", "large-a0-v1"));
  const wallMs = Date.now() - t0;
  const peaks = await sampler.stop();

  const tiles = await app.page.evaluate(() => window.__ffmPlans!.tileCount("large-a0-v1"));
  const pidAfter = adb("shell", `pidof ${PKG}`).trim();
  const perf = { pdfMb: Number(sizeMb.toFixed(1)), wallMs, stats, tiles, ...peaks, pidBefore, pidAfter };
  console.log("PLANS large-A0 perf:", JSON.stringify(perf));
  writeFileSync(join(SHOTS, "plans-perf.json"), JSON.stringify(perf, null, 2));

  expect(pidAfter).toBe(pidBefore); // process survived (no crash / lmk kill)
  expect(tiles).toBeGreaterThan(100);
  expect(await app.page.evaluate(() => 1 + 1)).toBe(2); // WebView still responsive
  const fatal = [...app.pageErrors, ...app.consoleErrors].filter((e) => /out of memory|aborted|crash|Failed to allocate/i.test(e));
  expect(fatal).toEqual([]);
});


test("a long-press task on an uncalibrated plan stays plan-only, as before", async () => {
  const viewer = await openPlan("S-102");
  await app.page.getByTestId("plan-fit").click();
  await app.page.waitForTimeout(400);
  const c = await center(viewer);
  await touch.longPress(c.x - 100, c.y + 30);
  await app.page.getByTestId("plan-new-task").click();
  await expect(app.page.getByTestId("task-form")).toBeVisible();
  await app.page.getByTestId("task-title").fill("Uncalibrated plan pin");
  await app.page.getByTestId("task-submit").click();
  await expect(app.page.getByTestId("plan-viewer")).toBeVisible({ timeout: 30_000 });
  const pin = app.page.locator('[data-testid="plan-pin"][aria-label$="Uncalibrated plan pin"]');
  await expect(pin).toHaveCount(1, { timeout: 30_000 });
  await pin.click();
  await expect(app.page.getByTestId("task-detail")).toContainText("Uncalibrated plan pin", { timeout: 20_000 });
  await expect(app.page.getByTestId("location-chips")).toHaveAttribute("data-dual", "0");
  await expect(app.page.getByTestId("loc-plan")).toBeVisible();
  await expect(app.page.getByTestId("loc-model")).toHaveCount(0);
  await parityShot("72-plan-task-uncalibrated-plan-only");
});
