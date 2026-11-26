import { expect, test, type Locator } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ACTIVITY, launchApp, PKG, SHOTS, type AppSession } from "./app";
import { setRotation } from "./qa";
import { snapUi, sysVisible, tapSys } from "./sysui";

test.describe.configure({ mode: "serial" });
test.setTimeout(240_000);

let app: AppSession;
const TITLE = "Cracked slab at grid B4";
let taskId = "";

async function signIn() {
  await app.page.getByTestId("demo-signin").click();
  const picker = app.page.getByTestId("project-picker");
  const tabs = app.page.getByTestId("tabs");
  await expect(picker.or(tabs)).toBeVisible();
  if (await picker.isVisible()) await app.page.getByTestId("project-default-project").click();
  await expect(tabs).toBeVisible();
}

async function openTasks() {
  await app.page.getByTestId("tabs").getByRole("link", { name: "Tasks", exact: true }).click();
  await expect(app.page.getByTestId("tasks-list-pane")).toBeVisible();
}

/** A real JPEG made in the WebView, pushed to the shared gallery. */
async function pushGalleryJpeg() {
  const b64 = await app.page.evaluate(async () => {
    const c = document.createElement("canvas");
    c.width = 1600;
    c.height = 1200;
    const g = c.getContext("2d")!;
    g.fillStyle = "#8a9ba8";
    g.fillRect(0, 0, 1600, 1200);
    g.fillStyle = "#c9b27c";
    g.fillRect(200, 300, 1200, 600);
    g.fillStyle = "#222";
    g.font = "80px sans-serif";
    g.fillText("SLAB B4", 600, 640);
    const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), "image/jpeg", 0.9));
    const buf = new Uint8Array(await blob.arrayBuffer());
    let s = "";
    for (const x of buf) s += String.fromCharCode(x);
    return btoa(s);
  });
  const local = join(SHOTS, "gallery.jpg");
  writeFileSync(local, Buffer.from(b64, "base64"));
  await app.device.push(local, "/sdcard/Pictures/ffm-gallery.jpg");
  await app.shell("am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file:///sdcard/Pictures/ffm-gallery.jpg");
}

async function drawOn(canvas: Locator, from: [number, number], to: [number, number]) {
  const box = (await canvas.boundingBox())!;
  const p = app.page;
  await p.mouse.move(box.x + box.width * from[0], box.y + box.height * from[1]);
  await p.mouse.down();
  await p.mouse.move(box.x + box.width * ((from[0] + to[0]) / 2), box.y + box.height * ((from[1] + to[1]) / 2), { steps: 4 });
  await p.mouse.move(box.x + box.width * to[0], box.y + box.height * to[1], { steps: 4 });
  await p.mouse.up();
}

async function shot(name: string) {
  await app.page.screenshot({ path: join(SHOTS, `${name}.png`) });
  await app.device.screenshot({ path: join(SHOTS, `${name}-device.png`) }).catch(() => undefined);
}

/** Attach to the current WebView (the activity is recreated when the display density changes). */
async function reattach() {
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    try {
      const webView = await app.device.webView({ pkg: PKG }, { timeout: 30_000 });
      const page = await webView.page();
      await page.evaluate(() => 1);
      await new Promise((r) => setTimeout(r, 1500)); // a second recreation may follow
      await page.evaluate(() => 1);
      app.page = page;
      return;
    } catch {
      /* the WebView is being recreated: retry */
    }
  }
  throw new Error("could not re-attach to the WebView");
}

/** Kill the app process (like the OS would) and attach to the fresh WebView; app data is kept. */
async function relaunch() {
  await app.shell(`am force-stop ${PKG}`);
  await app.shell(`am start -n ${ACTIVITY}`);
  const webView = await app.device.webView({ pkg: PKG }, { timeout: 60_000 });
  app.page = await webView.page();
}

test.beforeAll(async () => {
  app = await launchApp();
});
test.afterAll(async () => {
  await app?.shell("cmd connectivity airplane-mode disable").catch(() => undefined);
  await app?.shell("wm size reset; wm density reset").catch(() => undefined);
  if (app) await setRotation(app, 0).catch(() => undefined);
  await app?.close();
});

test("sign in and open the tasks tab (tablet split view)", async () => {
  await signIn();
  await openTasks();
  await expect(app.page.getByTestId("task-row").first()).toBeVisible({ timeout: 30_000 });
  // split view needs >= 840 dp: landscape on the target tablet (portrait is 800 dp, single pane)
  await setRotation(app, 1);
  await expect.poll(() => app.page.evaluate(() => window.innerWidth)).toBeGreaterThanOrEqual(840);
  await expect(app.page.getByTestId("task-detail")).toBeVisible();
  await shot("tasks-10-tablet-list");
  await setRotation(app, 0);
  await expect.poll(() => app.page.evaluate(() => window.innerWidth < window.innerHeight)).toBe(true);
});

test("status chips, search and column filters narrow the list (the web's filters)", async () => {
  const rows = app.page.getByTestId("task-row");
  await app.page.getByTestId("chip-all").click();
  const all = await rows.count();
  await app.page.getByTestId("chip-40").click();
  await expect(rows.first()).toBeVisible();
  for (const s of await rows.evaluateAll((els) => els.map((e) => e.getAttribute("data-status")))) expect(s).toBe("40");
  await app.page.getByTestId("chip-closed").click();
  for (const s of await rows.evaluateAll((els) => els.map((e) => e.getAttribute("data-status")))) expect(["65", "80"]).toContain(s);
  await app.page.getByTestId("chip-all").click();
  expect(await rows.count()).toBe(all);
  await app.page.getByTestId("task-search").fill("zzzz-nothing");
  await expect(app.page.getByTestId("tasks-empty")).toHaveAttribute("data-reason", "filtered");
  await app.page.getByTestId("task-search").fill("");
  await expect(rows.first()).toBeVisible();
});

test("filters sheet: column filters from the registry, active chips, badge, clear all", async () => {
  const rows = app.page.getByTestId("task-row");
  await app.page.getByTestId("chip-all").click();
  const all = await rows.count();
  await app.page.getByTestId("filter-button").click();
  await expect(app.page.getByTestId("filter-sheet")).toBeVisible();
  await shot("tasks-15-filter-sheet");
  // landscape (>= 840 dp): the same sheet is a side panel
  await app.page.getByTestId("filter-show").click();
  await setRotation(app, 1);
  await expect.poll(() => app.page.evaluate(() => window.innerWidth)).toBeGreaterThanOrEqual(840);
  await app.page.getByTestId("filter-button").click();
  await app.page.getByTestId("filter-head-status").click();
  await shot("tasks-15b-filter-sheet-landscape");
  await app.page.getByTestId("filter-show").click();
  await setRotation(app, 0);
  await expect.poll(() => app.page.evaluate(() => window.innerWidth < window.innerHeight)).toBe(true);
  await app.page.getByTestId("filter-button").click();
  await expect(app.page.getByTestId("filter-sheet")).toBeVisible();
  await app.page.getByTestId("filter-head-status").click();
  await app.page.getByTestId("fopt-status-Ongoing").click();
  await app.page.getByTestId("filter-show").click();
  await expect(app.page.getByTestId("filter-badge")).toHaveText("1");
  await expect(app.page.getByTestId("active-status")).toContainText("Ongoing");
  await shot("tasks-16-filter-active");
  for (const s of await rows.evaluateAll((els) => els.map((e) => e.getAttribute("data-status")))) expect(s).toBe("20");
  // a second filter ANDs across columns
  await app.page.getByTestId("filter-button").click();
  await app.page.getByTestId("filter-head-deadline").click();
  await app.page.getByTestId("fopt-deadline-none").click();
  await app.page.getByTestId("filter-show").click();
  await expect(app.page.getByTestId("filter-badge")).toHaveText("2");
  await app.page.getByTestId("active-remove-deadline").click();
  await expect(app.page.getByTestId("filter-badge")).toHaveText("1");
  await app.page.getByTestId("filters-clear-all").click();
  await expect(app.page.getByTestId("filter-badge")).toHaveCount(0);
  expect(await rows.count()).toBe(all);
});

test("saved views apply the web presets and survive a reload", async () => {
  const rows = app.page.getByTestId("task-row");
  await app.page.getByTestId("view-overdue").click();
  await expect(app.page.getByTestId("view-overdue")).toHaveAttribute("aria-selected", "true");
  await shot("tasks-17-view-overdue");
  await app.page.getByTestId("view-my").click();
  await expect(app.page.getByTestId("chip-open")).toHaveAttribute("aria-selected", "true"); // "My tasks" selects the Open chip, like the web
  await expect.poll(() => app.page.evaluate(() => localStorage.getItem("ff-task-views"))).toBe("my");
  await app.page.getByTestId("view-all").click();
  await expect(app.page.getByTestId("chip-all")).toHaveAttribute("aria-selected", "true");
  await expect(rows.first()).toBeVisible();
});

test("detail: priority, checklist, watchers and the building show and edit (demo)", async () => {
  await app.page.getByTestId("chip-all").click();
  await app.page.locator('[data-testid="task-row"][data-status="20"]').first().click(); // an open task: the extras are editable
  await expect(app.page.getByTestId("task-detail")).toBeVisible();
  await expect(app.page.getByTestId("detail-building")).toBeVisible();
  await app.page.getByTestId("priority-button").click();
  await app.page.getByTestId("priority-critical").click();
  await expect(app.page.getByTestId("detail-priority")).toHaveAttribute("data-priority", "critical");
  await app.page.getByTestId("checklist-new").fill("Photograph the crack");
  await app.page.getByTestId("checklist-add").click();
  const item = app.page.locator('[data-testid^="checklist-item-"]').first();
  // the list re-renders when the new item lands: retry the tap instead of asserting the state in the same frame
  await expect(async () => {
    if (!(await item.isChecked())) await item.click();
    await expect(item).toBeChecked({ timeout: 2000 });
  }).toPass({ timeout: 15_000 });
  await expect(app.page.getByTestId("detail-checklist")).toHaveAttribute("data-done", "1");
  await app.page.getByTestId("detail-follow").click();
  await expect(app.page.getByTestId("detail-watchers")).toHaveAttribute("data-count", "1");
  await shot("tasks-18-detail-extras");
  await app.page.getByTestId("task-back").click();
  await expect(app.page.getByTestId("row-checklist").first()).toBeVisible();
});

test("create a task offline with a gallery photo and a camera photo, both annotated", async () => {
  await app.shell("cmd connectivity airplane-mode enable");
  await expect(app.page.getByTestId("sync-chip")).toHaveAttribute("data-state", "offline", { timeout: 30_000 });
  await expect(app.page.getByTestId("offline-banner")).toBeVisible();

  await app.page.getByTestId("new-task").click();
  await app.page.getByTestId("task-title").fill(TITLE);
  await app.page.getByTestId("task-description").fill("Hairline crack along the slab edge, about 2 m.");
  await app.page.getByTestId("type-Defect").click();
  await app.page.getByTestId("task-assignee").selectOption({ index: 1 });
  await app.page.getByTestId("task-storey").fill("Level 02");
  // priority and a checklist item are set on the same screen (applied right after the create)
  await app.page.getByTestId("priority-button").click();
  await app.page.getByTestId("priority-high").click();
  await expect(app.page.getByTestId("detail-priority")).toHaveAttribute("data-priority", "high");
  await app.page.getByTestId("checklist-new").fill("Measure the crack width");
  await app.page.getByTestId("checklist-add").click();

  // gallery path
  await pushGalleryJpeg();
  await app.page.getByTestId("photo-gallery").click();
  await app.page.waitForTimeout(4000);
  await snapUi(app, "gallery-picker");
  await tapSys(app, /^Photo taken on/i, 45_000);
  await expect(app.page.getByTestId("photo-tile")).toHaveCount(1, { timeout: 60_000 });
  await shot("tasks-20-form-photo");

  // annotate: pen, arrow, box, text; undo/redo
  await app.page.getByTestId("photo-annotate").first().click();
  const canvas = app.page.getByTestId("annot-canvas");
  await expect(canvas).toBeVisible();
  await drawOn(canvas, [0.2, 0.3], [0.5, 0.45]);
  await app.page.getByTestId("tool-arrow").click();
  await drawOn(canvas, [0.7, 0.2], [0.55, 0.5]);
  await app.page.getByTestId("tool-rect").click();
  await app.page.getByTestId("color-0a84ff").click();
  await drawOn(canvas, [0.3, 0.5], [0.7, 0.8]);
  await expect(canvas).toHaveAttribute("data-shapes", "3");
  await app.page.getByTestId("annot-undo").click();
  await expect(canvas).toHaveAttribute("data-shapes", "2");
  await app.page.getByTestId("annot-redo").click();
  await expect(canvas).toHaveAttribute("data-shapes", "3");
  await app.page.getByTestId("tool-text").click();
  const box = (await canvas.boundingBox())!;
  await app.page.mouse.click(box.x + box.width * 0.1, box.y + box.height * 0.8);
  await app.page.getByTestId("annot-text-input").fill("crack");
  await app.page.getByTestId("annot-text-add").click();
  await expect(canvas).toHaveAttribute("data-shapes", "4");
  await shot("tasks-21-annotate");
  await app.page.getByTestId("annot-done").click();
  await expect(app.page.getByTestId("annotation-editor")).toHaveCount(0);
  await expect(app.page.getByTestId("photo-tile")).toHaveCount(1);

  // camera path (the emulator camera is a virtual scene)
  await app.shell(`pm grant ${PKG} android.permission.CAMERA`);
  await app.page.getByTestId("photo-camera").click();
  await app.page.waitForTimeout(6000);
  await snapUi(app, "camera-app");
  await tapSys(app, /shutter_button/, 60_000);
  await app.page.waitForTimeout(3000);
  await snapUi(app, "camera-shot");
  await tapSys(app, /done_button|btn_done|review_ok|^Done$|^OK$/i, 30_000);
  await expect(app.page.getByTestId("photo-tile")).toHaveCount(2, { timeout: 60_000 });

  await app.page.getByTestId("task-submit").click();
  await expect(app.page.getByTestId("detail-title")).toHaveText(TITLE, { timeout: 20_000 });
  taskId = (await app.page.getByTestId("task-detail").getAttribute("data-task-id"))!;
  await expect(app.page.getByTestId("task-photos").getByTestId("task-photo")).toHaveCount(2);
  await expect(app.page.getByTestId("detail-priority")).toHaveAttribute("data-priority", "high", { timeout: 20_000 });
  await expect(app.page.getByTestId("detail-checklist")).toContainText("Measure the crack width");
  await shot("tasks-22-created-offline");
  // visible in the list, queued while offline (single pane in portrait: go back to the list first)
  const row = app.page.locator(`[data-testid="task-row"][data-task-id="${taskId}"]`);
  const singlePane = !(await row.isVisible());
  if (singlePane) await openTasks();
  await expect(row.getByTestId("sync-badge")).toHaveAttribute("data-state", /pending/);
  if (singlePane) {
    // the next test continues on the task detail
    await row.click();
    await expect(app.page.getByTestId("detail-title")).toHaveText(TITLE, { timeout: 20_000 });
  }
});

test("comment and change status while offline, then everything syncs", async () => {
  await app.page.getByTestId("comment-input").fill("Photos attached, checking with the engineer.");
  await app.page.getByTestId("comment-send").click();
  await expect(app.page.getByTestId("timeline-entry").filter({ hasText: "checking with the engineer" })).toBeVisible();
  await app.page.getByTestId("action-complete").click();
  await expect(app.page.getByTestId("task-detail").getByTestId("status-chip")).toHaveText("Awaiting approval");
  await shot("tasks-30-status");

  await app.shell("cmd connectivity airplane-mode disable");
  await expect(app.page.getByTestId("sync-chip")).toHaveAttribute("data-state", "online", { timeout: 60_000 });
  await expect(app.page.getByTestId("task-detail").getByTestId("sync-badge")).toHaveCount(0, { timeout: 90_000 });
});

test("the task opens after an app relaunch", async () => {
  await relaunch();
  await expect(app.page.getByTestId("tabs")).toBeVisible({ timeout: 60_000 });
  await app.page.goto(app.page.url().split("#")[0] + `#/tasks/${taskId}`);
  await expect(app.page.getByTestId("detail-title")).toHaveText(TITLE, { timeout: 30_000 });
  await expect(app.page.getByTestId("timeline-entry").filter({ hasText: "checking with the engineer" })).toBeVisible();
  await expect(app.page.getByTestId("task-detail").getByTestId("status-chip")).toHaveText("Awaiting approval");
});

test("a draft survives am force-stop", async () => {
  await openTasks(); // single pane: "New task" lives on the list, not the detail
  await app.page.getByTestId("new-task").click();
  await app.page.getByTestId("task-title").fill("Draft: missing handrail");
  await app.page.getByTestId("task-description").fill("Stairwell 3");
  await expect(app.page.getByTestId("draft-status")).toHaveAttribute("data-saved", "1", { timeout: 10_000 });
  await relaunch();
  await expect(app.page.getByTestId("tabs")).toBeVisible({ timeout: 60_000 });
  await openTasks();
  await app.page.getByTestId("folder-drafts").click();
  await expect(app.page.getByTestId("draft-row")).toContainText("Draft: missing handrail");
  await app.page.getByTestId("draft-row").click();
  await expect(app.page.getByTestId("task-title")).toHaveValue("Draft: missing handrail");
  await expect(app.page.getByTestId("task-description")).toHaveValue("Stairwell 3");
  await shot("tasks-40-draft-restored");
  await app.page.getByTestId("task-discard").click();
  await app.page.getByTestId("folder-drafts").click();
  await expect(app.page.getByTestId("drafts-empty")).toBeVisible();
});

test("New task is a focused screen: no task list, both orientations; Close keeps the draft and returns to the list", async () => {
  await openTasks();
  await app.page.getByTestId("chip-all").click(); // the list shows rows, so "no task-row" below means something
  await expect(app.page.getByTestId("task-row").first()).toBeVisible();
  await app.page.getByTestId("new-task").click();
  await expect(app.page.getByTestId("task-form")).toBeVisible();
  const listFree = async () => {
    await expect(app.page.getByTestId("task-row")).toHaveCount(0);
    await expect(app.page.getByTestId("tasks-list-pane")).toHaveCount(0);
    await expect(app.page.getByTestId("tasks-split")).toHaveCount(0);
    await expect(app.page.getByTestId("tabs")).toHaveCount(0);
  };
  await listFree();
  // 44 px targets for the controls the user touches most
  for (const id of ["task-back", "task-submit", "task-discard", "task-title"]) {
    const box = (await app.page.getByTestId(id).boundingBox())!;
    expect(box.height, id).toBeGreaterThanOrEqual(43.5);
  }
  await app.page.getByTestId("task-title").fill("Focused screen draft");
  await expect(app.page.getByTestId("draft-status")).toHaveAttribute("data-saved", "1", { timeout: 10_000 });
  await shot("tasks-70-new-task-portrait");

  // soft keyboard: the focused field and the Create bar stay on screen (the shell resizes the content area)
  await app.shell("settings put secure show_ime_with_hard_keyboard 1").catch(() => undefined);
  await app.page.getByTestId("task-description").click();
  await app.page.waitForTimeout(2000);
  const inView = async (id: string) => {
    const b = (await app.page.getByTestId(id).boundingBox())!;
    const vh = await app.page.evaluate(() => window.visualViewport?.height ?? window.innerHeight);
    expect(b.y, id).toBeGreaterThanOrEqual(-1);
    expect(b.y + b.height, id).toBeLessThanOrEqual(vh + 1);
  };
  await inView("task-description");
  await inView("task-submit");
  await shot("tasks-72-new-task-keyboard");
  await app.shell("input keyevent 111").catch(() => undefined); // dismiss the keyboard (ESC)

  for (const rot of [1, 0] as const) {
    await setRotation(app, rot);
    await app.page.waitForTimeout(2500);
    await expect(app.page.getByTestId("task-title")).toHaveValue("Focused screen draft");
    await listFree();
    // the Create bar stays on screen in both geometries
    const send = (await app.page.getByTestId("task-submit").boundingBox())!;
    const vh = await app.page.evaluate(() => window.innerHeight);
    expect(send.y + send.height).toBeLessThanOrEqual(vh + 1);
    if (rot === 1) await shot("tasks-71-new-task-landscape");
  }
  await setRotation(app, 0);

  // Close returns to the list and the draft stays in the Drafts folder
  await app.page.getByTestId("task-back").click();
  await expect(app.page.getByTestId("tasks-list-pane")).toBeVisible();
  await app.page.getByTestId("folder-drafts").click();
  await expect(app.page.getByTestId("draft-row")).toContainText("Focused screen draft");
  await app.page.getByTestId("draft-row").click();
  await expect(app.page.getByTestId("task-title")).toHaveValue("Focused screen draft");
  await app.page.getByTestId("task-discard").click();
  await expect(app.page.getByTestId("tasks-list-pane")).toBeVisible();
});

test("camera permission denial shows a friendly message", async () => {
  await app.shell(`pm revoke ${PKG} android.permission.CAMERA`); // the OS restarts the app process
  await relaunch();
  await expect(app.page.getByTestId("tabs")).toBeVisible({ timeout: 60_000 });
  await openTasks();
  await app.page.getByTestId("new-task").click();
  await app.page.getByTestId("photo-camera").click();
  await tapSys(app, /permission_deny_button|Don.t allow|Deny/i, 30_000).catch(() => undefined);
  await expect(app.page.getByTestId("photo-message")).toContainText(/Camera access is turned off|denied/i, { timeout: 30_000 });
  expect(await sysVisible(app, /permission_deny_button/)).toBe(false);
  await shot("tasks-50-permission-denied");
  await app.page.getByTestId("task-discard").click();
  await app.shell(`pm grant ${PKG} android.permission.CAMERA`);
  await relaunch();
  await expect(app.page.getByTestId("tabs")).toBeVisible({ timeout: 60_000 });
});

test("phone layout (1080x2340 @ 440dpi): stacked list, detail and form", async () => {
  test.skip(!!process.env.FFM_ALLOW_DEVICE, "changes the display size: emulator only");
  await app.shell("wm size 1080x2340");
  await app.shell("wm density 440");
  await reattach();
  await expect(app.page.locator(".shell")).toHaveAttribute("data-layout", "phone", { timeout: 20_000 });
  await openTasks();
  await expect(app.page.getByTestId("task-detail")).toHaveCount(0);
  await shot("tasks-60-phone-list");
  await app.page.getByTestId("chip-40").click(); // the task was submitted for approval
  await app.page.locator(`[data-testid="task-row"][data-task-id="${taskId}"]`).click();
  await expect(app.page.getByTestId("detail-title")).toHaveText(TITLE);
  await shot("tasks-61-phone-detail");
  await app.page.getByTestId("task-back").click();
  await app.page.getByTestId("new-task").click();
  await shot("tasks-62-phone-form");
  await app.page.getByTestId("task-discard").click();
  await app.shell("wm size reset");
  await app.shell("wm density reset");
  await reattach();
  // back to the AVD's own layout (split from 840 dp: ffm_x216 portrait is single pane, ffm_tablet is split)
  await expect
    .poll(async () => (await app.page.locator(".shell").getAttribute("data-layout")) === ((await app.page.evaluate(() => window.innerWidth)) >= 840 ? "tablet" : "phone"), { timeout: 20_000 })
    .toBe(true);
});
