import { _android, type AndroidDevice, type Page } from "playwright-core";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { loadCompany } from "./company";

/** The installed app's package id: company.config.json (the Gradle applicationId). */
export const PKG = loadCompany().applicationId;
/** The launcher activity class. It lives in the fixed code package, not under the (configurable) application id. */
export const ACTIVITY = `${PKG}/app.freefield.field.MainActivity`;
export const SHOTS = join(process.cwd(), "test-results");

/**
 * Commands a spec may never send to a physical device: display size/density overrides (reads like a bare
 * `wm size` are fine), rotation, font scale, night mode, and dismissing the lock screen.
 */
export const DEVICE_FORBIDDEN = /\bwm\s+(size|density)\s+\S|dismiss-keyguard|user_rotation|user-rotation|accelerometer_rotation|font_scale|uimode\s+night/;

export interface AppSession {
  device: AndroidDevice;
  page: Page;
  consoleErrors: string[];
  pageErrors: string[];
  shot(name: string): Promise<void>;
  /** Run `adb shell <cmd>` on the device. */
  shell(cmd: string): Promise<string>;
  close(): Promise<void>;
}

/** App session: clears app data (unless `clear: false`), launches, attaches to the WebView. */
export async function launchApp(opts: { clear?: boolean } = {}): Promise<AppSession> {
  mkdirSync(SHOTS, { recursive: true });
  // Never touch a physical device that happens to be attached: only the emulator, or the one serial the
  // operator opted into explicitly (FFM_ALLOW_DEVICE, exact match; scripts/device-session.sh sets it up).
  const serial = process.env.ANDROID_SERIAL ?? "emulator-5554";
  if (!serial.startsWith("emulator-") && serial !== process.env.FFM_ALLOW_DEVICE) throw new Error(`refusing non-emulator serial ${serial}`);
  const device = (await _android.devices({ omitDriverInstall: true })).find((d) => d.serial() === serial);
  if (!device) throw new Error(`emulator ${serial} not attached`);
  const physical = !serial.startsWith("emulator-");

  // A sleeping display turns device screenshots black (emu-session also sets stayon; this covers long runs).
  // On a physical device only wake the screen: never dismiss its lock screen.
  await device.shell(physical ? "input keyevent KEYCODE_WAKEUP" : "input keyevent KEYCODE_WAKEUP; wm dismiss-keyguard").catch(() => undefined);
  if (opts.clear ?? true) await device.shell(`pm clear ${PKG}`);
  await device.shell(`am start -n ${ACTIVITY}`);
  // Right after the previous spec tore its session down the WebView devtools socket sometimes never shows up
  // (seen once in ~4 full runs); a fresh process start fixes it. One retry, logged so it stays visible.
  const webView = await device.webView({ pkg: PKG }, { timeout: 45_000 }).catch(async (e) => {
    console.log(`launchApp: WebView not found in 45s (${String(e).split("\n")[0]}); restarting the app once`);
    await device.shell(`am force-stop ${PKG}`);
    await device.shell(`am start -n ${ACTIVITY}`);
    return device.webView({ pkg: PKG }, { timeout: 60_000 });
  });
  const page = await webView.page();

  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  const session: AppSession = {
    device,
    page,
    consoleErrors,
    pageErrors,
    shot: async (name) => {
      // WebView capture: the device framebuffer can show system dialogs (ANR on a slow software GPU).
      // session.page, not the first page: specs swap it after the WebView target is recreated
      // best-effort: with a heavy WebGL scene on the software GPU a WebView frame can take > 30 s
      await session.page.screenshot({ path: join(SHOTS, `${name}.png`), timeout: 10_000 }).catch(() => console.log(`page shot ${name} skipped (slow frame)`));
      // Compositor framebuffer: the only capture that includes WebGL canvas pixels.
      await device.screenshot({ path: join(SHOTS, `${name}-device.png`) }).catch(() => undefined);
    },
    shell: async (cmd) => {
      if (physical && DEVICE_FORBIDDEN.test(cmd)) throw new Error(`refusing on a physical device (display/lock settings): ${cmd}`);
      return (await device.shell(cmd)).toString("utf8");
    },
    close: async () => {
      await device.shell(`am force-stop ${PKG}`).catch(() => undefined);
      await device.close();
    },
  };
  return session;
}

declare global {
  interface Window {
    __ffmPlans?: {
      renderStored(blobKey: string, planVersionId: string, tuning?: unknown): Promise<unknown>;
      hasPdf(blobKey: string): Promise<boolean>;
      tileCount(planVersionId: string): Promise<number>;
      heapMb(): number | null;
      renderRuns(): number;
      lastStats(): { ms: number; tiles: number; levelMs: number[]; marks: { inputMs: number; hashMs: number; openMs: number; previewMs: number; previewPx: number; firstTileMs: number; totalMs: number } } | null;
      cropPng(planVersionId: string, rect: { x: number; y: number; w: number; h: number }, outWidth: number): Promise<string | null>;
      manifestInfo(planVersionId: string): Promise<{ levels: number; finestScale: number; complete: boolean; pageWidth: number; pageHeight: number } | null>;
    };
    __ffmTest?: {
      simulateRemote(spec: { taskId?: string; action: "create" | "assign" | "comment" | "complete"; title?: string; text?: string; assignToMe?: boolean; deadline?: number | null; by?: { uid: string; name: string }; asMe?: boolean }): Promise<string>;
      tapNotification(tap: { path: string; projectId: string | null }): void;
      createTask(title: string, opts?: { location?: unknown; buildingId?: string | null }): Promise<string>;
      createTaskWithPhotos(title: string, count: number, kb?: number): Promise<string>;
    };
    __ffmModel?: {
      webgl2: boolean;
      renderer: string | null;
      installMs: number | null;
      loadMs: number | null;
      modelsLoaded: number;
      heapMbBefore: number | null;
      heapMbAfter: number | null;
      errors: string[];
    };
  }
}

/**
 * The e2e test hooks (`window.__ffmTest`) mount from a lazily loaded chunk, so right after a launch or a
 * relaunch they can lag the first paint. Wait for them before calling into them.
 */
export async function waitForTestHooks(page: Page, timeout = 30_000): Promise<void> {
  await page.waitForFunction(() => !!(window as unknown as { __ffmTest?: unknown }).__ffmTest, undefined, { timeout });
}

/** Real touch input through the WebView's DevTools protocol (multi-touch is not possible with `adb input`). */
export async function touchSession(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  const send = (type: "touchStart" | "touchMove" | "touchEnd", pts: { x: number; y: number; id: number }[]) =>
    cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : pts.map((p) => ({ x: p.x, y: p.y, id: p.id })) });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  return {
    /** Two fingers moving apart (scale > 1) or together, centred on (cx, cy). */
    async pinch(cx: number, cy: number, fromDist: number, toDist: number, steps = 12) {
      const pts = (d: number) => [
        { x: cx - d / 2, y: cy, id: 1 },
        { x: cx + d / 2, y: cy, id: 2 },
      ];
      await send("touchStart", pts(fromDist));
      for (let i = 1; i <= steps; i++) {
        await send("touchMove", pts(fromDist + ((toDist - fromDist) * i) / steps));
        await sleep(16);
      }
      await send("touchEnd", []);
    },
    /**
     * The start and the first move are pipelined (explicit timestamps) so CDP latency on a slow emulator cannot hold the finger
     * still past the long-press time before it moves; the remaining steps keep their real pacing.
     */
    async drag(x0: number, y0: number, x1: number, y1: number, steps = 10) {
      const t0 = Date.now() / 1000;
      const first = { x: x0 + (x1 - x0) / steps, y: y0 + (y1 - y0) / steps, id: 1 };
      await Promise.all([
        cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: x0, y: y0, id: 1 }], timestamp: t0 }),
        cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [first], timestamp: t0 + 0.016 }),
      ]);
      await sleep(16);
      for (let i = 2; i <= steps; i++) {
        await send("touchMove", [{ x: x0 + ((x1 - x0) * i) / steps, y: y0 + ((y1 - y0) * i) / steps, id: 1 }]);
        await sleep(16);
      }
      await send("touchEnd", []);
    },
    /** Swipe with explicit event timestamps (pipelined) so CDP latency cannot fake a pause before release. */
    async swipe(x0: number, y0: number, x1: number, y1: number, steps = 6, stepMs = 16) {
      const t0 = Date.now() / 1000;
      const ev = (type: "touchStart" | "touchMove" | "touchEnd", x: number, y: number, at: number) =>
        cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y, id: 1 }], timestamp: t0 + at / 1000 });
      const all = [ev("touchStart", x0, y0, 0)];
      for (let i = 1; i <= steps; i++) all.push(ev("touchMove", x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps, i * stepMs));
      all.push(ev("touchEnd", x1, y1, steps * stepMs + 4));
      await Promise.all(all);
    },
    /** Pipelined with explicit timestamps (40 ms press) so CDP latency on a slow emulator cannot stretch a tap into a long press. */
    async tap(x: number, y: number) {
      const t0 = Date.now() / 1000;
      await Promise.all([
        cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 1 }], timestamp: t0 }),
        cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [], timestamp: t0 + 0.04 }),
      ]);
    },
    /**
     * Pipelined with explicit event timestamps so adb/CDP round-trip latency on a slow emulator
     * cannot stretch the gap between the two taps.
     */
    async doubleTap(x: number, y: number) {
      const t0 = Date.now() / 1000;
      const ev = (type: "touchStart" | "touchEnd", at: number) =>
        cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y, id: 1 }], timestamp: t0 + at });
      await Promise.all([ev("touchStart", 0), ev("touchEnd", 0.04), ev("touchStart", 0.13), ev("touchEnd", 0.17)]);
    },
    /** Put one finger down and keep it there: move it, then release (a screenshot in between sees the aim state). */
    async press(x: number, y: number) {
      await send("touchStart", [{ x, y, id: 1 }]);
      return {
        move: (nx: number, ny: number) => send("touchMove", [{ x: nx, y: ny, id: 1 }]),
        release: () => send("touchEnd", []),
      };
    },
    /** Two fingers move together by (dx, dy), centred on (cx, cy) and `dist` apart: a two-finger pan. */
    async twoFingerPan(cx: number, cy: number, dist: number, dx: number, dy: number, steps = 10) {
      const pts = (k: number) => [
        { x: cx - dist / 2 + dx * k, y: cy + dy * k, id: 1 },
        { x: cx + dist / 2 + dx * k, y: cy + dy * k, id: 2 },
      ];
      await send("touchStart", pts(0));
      for (let i = 1; i <= steps; i++) {
        await send("touchMove", pts(i / steps));
        await sleep(16);
      }
      await send("touchEnd", []);
    },
    async longPress(x: number, y: number, ms = 900) {
      await send("touchStart", [{ x, y, id: 1 }]);
      await sleep(ms);
      await send("touchEnd", []);
    },
    detach: () => cdp.detach(),
  };
}
