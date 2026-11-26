import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { launchApp, PKG, type AppSession } from "./app";
import { gotoModel } from "./model";

/**
 * Renderer-death recovery: kill the sandboxed WebView renderer (what lmkd does under memory pressure) and expect the
 * app to survive (same app pid), recreate the WebView and reopen the 3D route with the notice.
 */
test.describe.configure({ mode: "serial" });
test.setTimeout(360_000);
const hostAdb = (...a: string[]) => { try { return execFileSync("adb", ["-s", process.env.ANDROID_SERIAL ?? "emulator-5554", ...a], { encoding: "utf8", timeout: 20_000 }); } catch (e) { return String(e); } };
let app: AppSession;

const rendererPid = async () => (await app.shell("ps -A | grep sandboxed_process | head -1")).trim().split(/\s+/)[1] ?? "";
const appPid = async () => (await app.shell(`pidof ${PKG}`)).trim();

test.beforeAll(async () => {
  app = await launchApp();
  await app.page.getByTestId("demo-signin").click();
  const picker = app.page.getByTestId("project-picker");
  const tabs = app.page.getByTestId("tabs");
  await expect(picker.or(tabs)).toBeVisible();
  if (await picker.isVisible()) await app.page.getByTestId("project-default-project").click();
  await expect(tabs).toBeVisible();
});
test.afterAll(async () => {
  hostAdb("forward", "--remove", "tcp:9444");
  hostAdb("shell", `am force-stop ${PKG}`);
});

test("killing the renderer on the 3D route brings the app back on the same route with a notice", async () => {
  await gotoModel(app);
  const route = await app.page.evaluate(() => location.hash);
  expect(route).toMatch(/^#\/model/);
  const pidBefore = await appPid();
  const rBefore = await rendererPid();
  expect(rBefore).not.toBe("");
  await app.shell(`kill -9 ${rBefore} || su 0 kill -9 ${rBefore}`);
  // the app process must survive; a new renderer appears
  await expect.poll(async () => (await rendererPid()) !== "" && (await rendererPid()) !== rBefore, { timeout: 60_000 }).toBe(true);
  expect(await appPid(), "app process survived the renderer death").toBe(pidBefore);
  // re-attach to the recreated WebView with a fresh device connection (Playwright keeps returning the dead page of the
  // old renderer for the same app pid); `clear: false` keeps the app data and only brings the running activity forward
  // Playwright's Android driver keeps handing out the dead page of the old renderer (same app pid), so talk to the
  // recreated WebView directly: adb-forward its devtools socket and evaluate over a plain CDP websocket.
  const port = 9444;
  const sockets = () => [...new Set([...hostAdb("shell", "cat /proc/net/unix").matchAll(/@(webview_devtools_remote_\d+)/g)].map((m) => m[1]))];
  const cdpEval = async (expr: string): Promise<unknown> => {
    const sock = sockets()[0];
    if (!sock) throw new Error("no devtools socket");
    hostAdb("forward", `tcp:${port}`, `localabstract:${sock}`);
    const list = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as Array<{ type: string; url: string; webSocketDebuggerUrl: string }>;
    const target = list.find((t) => t.type === "page" && /localhost/.test(t.url));
    if (!target) throw new Error("no page target");
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error("ws error")); });
    try {
      return await new Promise((res, rej) => {
        const timer = setTimeout(() => rej(new Error("cdp timeout")), 10_000);
        ws.onmessage = (m) => { const r = JSON.parse(String(m.data)); if (r.id === 1) { clearTimeout(timer); res(r.result?.result?.value); } };
        ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true } }));
      });
    } finally {
      ws.close();
    }
  };
  await app.device.close().catch(() => undefined);
  let notice = "";
  const t0 = Date.now();
  while (Date.now() - t0 < 120_000) {
    try {
      notice = String((await cdpEval(`document.querySelector('[data-testid="recovery-notice"]')?.innerText ?? ''`)) ?? "");
      if (notice) break;
    } catch {
      /* page not up yet */
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  const state = await cdpEval(`JSON.stringify({ hash: location.hash, model: !!document.querySelector('[data-testid="model-page"]'), last: localStorage.getItem('ffm.lastRoute') })`).catch(() => "{}");
  console.log("AFTER KILL", notice, state);
  expect(notice).toMatch(/Reloaded the 3D view after running out of memory/);
  expect(JSON.parse(String(state)).hash).toBe(route);
  await expect.poll(async () => String(await cdpEval(`document.querySelector('[data-testid="model-page"]')?.getAttribute('data-phase') ?? 'none'`).catch(() => "none")), { timeout: 90_000, message: "the 3D route is open again and the model reloads" }).toBe("ready");
  await cdpEval(`document.querySelector('[data-testid="recovery-notice-dismiss"]')?.click()`);
  await expect.poll(async () => String(await cdpEval(`document.querySelector('[data-testid="recovery-notice"]')?.innerText ?? ''`)), { timeout: 10_000 }).toBe("");
  console.log("RECOVERY", JSON.stringify({ route, appPid: pidBefore, rendererBefore: rBefore }));
});
