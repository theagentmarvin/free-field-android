import { expect, test } from "@playwright/test";
import { launchApp, type AppSession } from "./app";
import { join } from "node:path";
import { SHOTS } from "./app";
import { decodePng } from "./png";
import { setRotation } from "./qa";

test.describe.configure({ mode: "serial" });

let app: AppSession;
test.beforeAll(async () => {
  app = await launchApp();
});
test.afterAll(async () => {
  if (app) await setRotation(app, 0).catch(() => undefined);
  await app?.close();
});

test("app boots to the sign-in screen", async () => {
  await expect(app.page.getByRole("heading", { name: "FreeField Field" })).toBeVisible();
  await expect(app.page.getByTestId("demo-signin")).toBeVisible();
  await app.shot("01-signin");
});

test("demo sign-in lands on the app shell (tablet layout)", async () => {
  await app.page.getByTestId("demo-signin").click();
  // Single demo membership may be auto-picked; otherwise choose it.
  const picker = app.page.getByTestId("project-picker");
  const tabs = app.page.getByTestId("tabs");
  await expect(picker.or(tabs)).toBeVisible();
  if (await picker.isVisible()) {
    await app.page.getByTestId("project-default-project").click();
  }
  await expect(tabs).toBeVisible();
  // Split layout from 840 dp (SPEC A8). The target tablet is 800 dp wide in portrait (single pane)
  // and 1280 dp in landscape (split); the large AVD is split in both.
  const layoutFor = async () => ((await app.page.evaluate(() => window.innerWidth)) >= 840 ? "tablet" : "phone");
  await expect(app.page.locator(".shell")).toHaveAttribute("data-layout", await layoutFor());
  await app.shot("02-shell");
  await setRotation(app, 1);
  await expect.poll(() => app.page.evaluate(() => window.innerWidth > window.innerHeight)).toBe(true);
  await expect(app.page.locator(".shell")).toHaveAttribute("data-layout", "tablet");
  await app.shot("02b-shell-landscape");
  await setRotation(app, 0);
  await expect.poll(() => app.page.evaluate(() => window.innerWidth < window.innerHeight)).toBe(true);
});

test("the app content sits below the status bar and above the navigation bar (edge-to-edge insets)", async () => {
  // The WebView reports env(safe-area-inset-*) as 0 on Android, so the native content root is inset
  // (MainActivity). A sleeping display delivers no status-bar inset and captures solid black, so wake
  // it first and treat a black capture as a capture failure, never as a pass.
  await app.shell(process.env.FFM_ALLOW_DEVICE ? "input keyevent KEYCODE_WAKEUP" : "input keyevent KEYCODE_WAKEUP; wm dismiss-keyguard");
  const screenH = Number(/Physical size: \d+x(\d+)/.exec(await app.shell("wm size"))?.[1] ?? "0");
  const bounds = async () => {
    await app.shell("uiautomator dump /sdcard/ffm-ui.xml >/dev/null");
    const node = /class="android\.webkit\.WebView"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(await app.shell("cat /sdcard/ffm-ui.xml"));
    expect(node, "WebView node in the UI dump").not.toBeNull();
    return { top: Number(node![2]), bottom: Number(node![4]) };
  };
  let b = await bounds();
  await expect
    .poll(async () => (b = await bounds()).top, { message: "WebView starts below the status bar", timeout: 15_000 })
    .toBeGreaterThan(0);
  console.log("webview bounds", { ...b, screenH });
  expect(b.bottom, "WebView ends above the navigation bar").toBeLessThan(screenH);

  // Pixels: the system-bar bands show the white app background, the capture is not black.
  const img = decodePng(await app.device.screenshot({ path: join(SHOTS, "inset-check-device.png") }));
  const px = (x: number, y: number) => {
    const i = (Math.min(img.height - 1, y) * img.width + x) * 4;
    return [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!];
  };
  const whiteFraction = (y0: number, y1: number, xa: number, xb: number) => {
    let white = 0;
    let n = 0;
    for (let y = y0; y < y1; y += 2) {
      for (let x = Math.floor(img.width * xa); x < img.width * xb; x += 4) {
        n++;
        const [r, g, bl] = px(x, y);
        if (r! > 240 && g! > 240 && bl! > 240) white++;
      }
    }
    return white / n;
  };
  const scale = img.height / screenH;
  expect(whiteFraction(0, Math.floor(b.top * scale) - 2, 0.35, 0.65), "status-bar band is the white app background").toBeGreaterThan(0.9);
  expect(whiteFraction(Math.ceil(b.bottom * scale) + 2, img.height, 0.05, 0.3), "navigation-bar band is the white app background").toBeGreaterThan(0.9);
});

test("tabs navigate", async () => {
  const tabs = app.page.getByTestId("tabs");
  for (const [label, probe] of [
    ["Plans", "plans-page"],
    ["Sync", "sync-page"],
    ["More", "more-page"],
  ] as const) {
    await tabs.getByRole("link", { name: label, exact: true }).click();
    await expect(app.page.getByTestId(probe)).toBeVisible();
  }
  await app.shot("03-more");
});

test("task list shows the demo tasks", async () => {
  await app.page.getByTestId("tabs").getByRole("link", { name: "Tasks", exact: true }).click();
  const rows = app.page.getByTestId("task-row");
  await expect(rows.first()).toBeVisible({ timeout: 30_000 });
  expect(await rows.count()).toBeGreaterThanOrEqual(4);
  // split view (detail beside the list) only from 840 dp; the portrait tablet is single-pane
  if ((await app.page.evaluate(() => window.innerWidth)) >= 840) await expect(app.page.getByTestId("task-detail")).toBeVisible();
  await app.shot("04-tasks");
});

test("airplane mode flips the sync chip offline and back", async () => {
  const chip = app.page.getByTestId("sync-chip");
  await expect(chip).toHaveAttribute("data-state", "online");
  await app.shell("cmd connectivity airplane-mode enable");
  await expect(chip).toHaveAttribute("data-state", "offline", { timeout: 30_000 });
  await app.shot("05-offline");
  await app.shell("cmd connectivity airplane-mode disable");
  await expect(chip).toHaveAttribute("data-state", "online", { timeout: 60_000 });
});

test("model tab renders a canvas and loads the .frag without WebGL errors", async () => {
  await app.page.getByTestId("tabs").getByRole("link", { name: "Model", exact: true }).click();
  const canvas = app.page.locator('[data-testid="model-page"] canvas').first();
  await expect(canvas).toBeVisible({ timeout: 60_000 });
  const box = await canvas.boundingBox();
  expect(box!.width).toBeGreaterThan(100);
  expect(box!.height).toBeGreaterThan(100);

  await expect
    .poll(() => app.page.evaluate(() => window.__ffmModel?.loadMs ?? null), { timeout: 90_000, intervals: [500] })
    .not.toBeNull();
  const metrics = await app.page.evaluate(() => window.__ffmModel);
  console.log("M0 model metrics:", JSON.stringify(metrics));
  expect(metrics?.webgl2).toBe(true);
  expect(metrics?.modelsLoaded).toBeGreaterThan(0);
  await app.page.waitForTimeout(1500); // let tiles stream in
  const heap = await app.page.evaluate(
    () => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null,
  );
  console.log("M0 JS heap after load (MB):", heap === null ? "n/a" : (heap / 1048576).toFixed(1));
  await app.shot("06-model");

  const glErrors = [...app.consoleErrors, ...app.pageErrors].filter((e) => /webgl|gl context|shader|context lost/i.test(e));
  expect(glErrors).toEqual([]);
});
