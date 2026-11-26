import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ACTIVITY, launchApp, PKG, SHOTS, type AppSession } from "./app";
import { APP_FILLER, restoreDevice, setFontScale, setNight, setRotation, tryRoot } from "./qa";
import { tapSys } from "./sysui";
import { linkDomain } from "./emulator/rest";

/**
 * Exploratory QA on the emulator (demo lane): device actions that real field use throws at the app.
 * Each test restores what it changed (afterEach/afterAll -> restoreDevice), even on failure.
 * Case numbers (A1..J65) refer to docs/qa/MATRIX.md.
 */
test.describe.configure({ mode: "serial" });
test.setTimeout(240_000);

let app: AppSession;
let rooted = false;

const tabs = () => app.page.getByTestId("tabs");
const goto = (route: string) => app.page.evaluate((r) => (window.location.hash = r), route);
const hash = () => app.page.evaluate(() => window.location.hash);
const nav = (name: string) => tabs().getByRole("link", { name, exact: true }).click();

async function signIn() {
  await app.page.getByTestId("demo-signin").click();
  const picker = app.page.getByTestId("project-picker");
  await expect(picker.or(tabs())).toBeVisible();
  if (await picker.isVisible()) await app.page.getByTestId("project-default-project").click();
  await expect(tabs()).toBeVisible();
}

/** Re-attach to the WebView after the app process was killed and restarted. */
async function relaunch(opts: { kill?: "force-stop" | "kill" } = {}) {
  if (opts.kill === "kill") await app.shell(`am kill ${PKG}`);
  else await app.shell(`am force-stop ${PKG}`);
  await app.shell(`am start -n ${ACTIVITY}`);
  await reattach(90_000);
  await expect(tabs()).toBeVisible({ timeout: 60_000 });
}

/**
 * Re-attach to the WebView after a configuration change (font scale, density, rotation) or an app restart. The old
 * devtools target can linger for a moment, so retry until a page with the tab bar answers.
 */
async function reattach(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 0; ; attempt++) {
    try {
      const wv = await app.device.webView({ pkg: PKG }, { timeout: 10_000 });
      const page = await wv.page();
      await page.getByTestId("tabs").waitFor({ state: "visible", timeout: 8_000 });
      app.page = page;
      return;
    } catch (e) {
      if (Date.now() > deadline) throw e;
      // Playwright keeps the stale (closed) devtools target cached on the device object: after two misses open a fresh
      // device session (keeps app data) so the new target is discovered.
      if (attempt >= 1) {
        const { pageErrors, consoleErrors } = app;
        await app.device.close().catch(() => undefined);
        app = await launchApp({ clear: false });
        app.pageErrors.push(...pageErrors);
        app.consoleErrors.push(...consoleErrors);
        if (await app.page.getByTestId("tabs").isVisible().catch(() => false)) return;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

/** True when nothing in the page scrolls sideways (content wider than the viewport = clipped controls). */
async function noHorizontalOverflow(page: Page): Promise<{ ok: boolean; offenders: string[] }> {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const offenders: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const cs = getComputedStyle(el);
      if (cs.position === "fixed") continue;
      if (r.right > vw + 1 && !el.closest(".folder-tabs, .tabbar, .rail, .chips, .sheet, [data-scroll-x]")) {
        offenders.push(`${el.tagName.toLowerCase()}[${el.getAttribute("data-testid") ?? el.className}] right=${Math.round(r.right)} vw=${vw}`);
      }
    }
    return { ok: offenders.length === 0, offenders: offenders.slice(0, 8) };
  });
}

test.beforeAll(async () => {
  app = await launchApp();
  rooted = await tryRoot(app);
  // tryRoot restarts adbd, which drops the Playwright device: reattach (keep app data)
  if (rooted) {
    await app.device.close().catch(() => undefined);
    app = await launchApp({ clear: false });
  }
  console.log(`emulator root shell: ${rooted}`);
  await signIn();
});
test.afterEach(async ({}, info) => {
  if (info.status !== info.expectedStatus) {
    await app.shot(`FAIL-qa-${info.title.slice(0, 20).replace(/\W+/g, "-")}`).catch(() => undefined);
    // a closed WebView target usually means the process died: keep the evidence
    console.log("pid:", (await app.shell(`pidof ${PKG}`).catch(() => "?")).trim() || "(gone)");
    console.log("CRASH LOG:", (await app.shell("logcat -b crash -d -t 40").catch(() => "")).slice(-2500));
    console.log("APP LOG:", (await app.shell(`logcat -d -t 400 | grep -E "${PKG}|AndroidRuntime|ActivityManager.*(kill|died)|FATAL" | tail -30`).catch(() => "")).slice(-3000));
    await app.device.screenshot({ path: join(SHOTS, "FAIL-qa-device-only.png") }).catch(() => undefined);
    console.log("PAGE ERRORS:", JSON.stringify(app.pageErrors.slice(-5)), "CONSOLE ERRORS:", JSON.stringify(app.consoleErrors.slice(-5)));
  }
});
test.afterAll(async () => {
  await restoreDevice(app);
  await app?.close();
});

// ── B57 back button ──────────────────────────────────────────────────────────

test("B57 back button: from the form, a nested screen and the root of each tab", async () => {
  await nav("Tasks");
  await expect(app.page.getByTestId("tasks-list-pane")).toBeVisible();
  await app.page.getByTestId("new-task").click();
  await app.page.getByTestId("task-title").fill("Back-button draft");
  await expect(app.page.getByTestId("draft-status")).toHaveAttribute("data-saved", "1", { timeout: 10_000 });
  await app.shell("input keyevent 4");
  await expect.poll(hash).toMatch(/#\/tasks$/);
  // the draft must not have been dropped by leaving the form with the system back key
  await app.page.getByTestId("folder-drafts").click();
  await expect(app.page.getByTestId("draft-row").filter({ hasText: "Back-button draft" })).toBeVisible();
  await app.page.getByTestId("draft-delete").first().click();
  await app.page.getByTestId("chip-open").click(); // the folder choice outlives the screen: leave the list on Open for later tests

  await nav("More");
  await app.page.getByTestId("open-offline").click();
  await expect.poll(hash).toMatch(/#\/offline$/);
  await app.shot("qa-b57-offline");
  await app.shell("input keyevent 4");
  await expect.poll(hash).toMatch(/#\/more$/);

  // the root of the home tab: Back leaves the app (and only there: every press above stayed inside it)
  await goto("/tasks");
  await expect.poll(hash).toMatch(/#\/tasks$/);
  await app.shell("input keyevent 4");
  await expect
    .poll(async () => (await app.shell("dumpsys activity activities | grep -m1 -E 'topResumedActivity|mResumedActivity'")).includes(PKG), { timeout: 10_000, intervals: [500] })
    .toBe(false);
  await new Promise((r) => setTimeout(r, 1500)); // let the finished Activity's WebView go before starting a new one
  await app.shell(`am start -n ${ACTIVITY}`);
  // leaving the app closed the WebView devtools target (Activity finished): reattach to the new one
  await reattach(90_000);
  await new Promise((r) => setTimeout(r, 2000)); // a dying target answers once and then closes: the page must still be there
  await reattach(90_000);
  await expect(tabs()).toBeVisible({ timeout: 30_000 });
  expect(await app.page.evaluate(() => document.body.innerText.trim().length)).toBeGreaterThan(20); // not a blank screen
});

// ── G46 permissions ──────────────────────────────────────────────────────────

test("G46 the manifest requests only what v1 uses", async () => {
  const dump = await app.shell(`dumpsys package ${PKG}`);
  const sect = dump.split("requested permissions:")[1]?.split(/install permissions:|runtime permissions:|User 0:/)[0] ?? "";
  const requested = sect.split("\n").map((l) => l.trim().replace(/:.*$/, "")).filter((l) => l.startsWith("android.permission."));
  console.log("requested permissions:", requested.join(", "));
  // Legitimate set, each with its reason:
  //  INTERNET / ACCESS_NETWORK_STATE: cloud sync and the online/offline chip
  //  CAMERA: task photos
  //  POST_NOTIFICATIONS: on-device notifications (@capacitor/local-notifications), asked in context
  //  RECEIVE_BOOT_COMPLETED: the notifications plugin re-arms its daily deadline alarms after a reboot
  //  WAKE_LOCK: merged in by the Capacitor/plugin libraries
  for (const want of ["INTERNET", "ACCESS_NETWORK_STATE", "CAMERA", "POST_NOTIFICATIONS", "RECEIVE_BOOT_COMPLETED"]) {
    expect(requested, `missing permission ${want}`).toContain(`android.permission.${want}`);
  }
  // Exact alarms are not needed (deadline reminders are inexact daily alarms) and must stay out.
  for (const bad of ["SCHEDULE_EXACT_ALARM", "USE_EXACT_ALARM", "RECORD_AUDIO", "READ_EXTERNAL_STORAGE", "WRITE_EXTERNAL_STORAGE", "READ_MEDIA", "LOCATION", "FOREGROUND_SERVICE", "READ_CONTACTS", "BLUETOOTH", "SYSTEM_ALERT_WINDOW"]) {
    expect(requested.filter((p) => p.includes(bad)), `unexpected permission ${bad}`).toEqual([]);
  }
});

// ── I56 tap targets ──────────────────────────────────────────────────────────

test("I56 primary controls are at least 44 css px (48 dp target budget) on tablet and phone", async () => {
  const audit = () =>
    app.page.evaluate(() => {
      const small: string[] = [];
      const sel = "button, a.btn, a.tab, a.row, input:not([type=checkbox]), select, textarea, [role=tab]";
      for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (Math.min(r.width, r.height) < 44) small.push(`${el.tagName.toLowerCase()}[${el.getAttribute("data-testid") ?? el.textContent?.trim().slice(0, 18)}] ${Math.round(r.width)}x${Math.round(r.height)}`);
      }
      return small;
    });
  await nav("Tasks");
  await app.page.getByTestId("new-task").click();
  const form = await audit();
  await app.page.getByTestId("task-discard").click();
  await nav("Tasks");
  const list = await audit();
  console.log("small targets, form:", form.join(" | "));
  console.log("small targets, list:", list.join(" | "));
  const all = [...form, ...list];
  // chip-x (remove pin) and similar tiny affordances are tracked in docs/qa/BUGS.md
  const critical = all.filter((s) => /task-submit|task-discard|comment-send|new-task|photo-camera|photo-gallery|folder-|\[Plans\]|\[Tasks\]|\[Sync\]|\[More\]|\[Model\]/.test(s));
  expect(critical).toEqual([]);
});

// ── D24 double tap ───────────────────────────────────────────────────────────

test("D24 a double tap on Post comment posts one comment", async () => {
  await nav("Tasks");
  await app.page.getByTestId("chip-open").click();
  await app.page.getByTestId("task-row").first().click();
  await expect(app.page.getByTestId("task-detail")).toBeVisible();
  const text = `double-tap ${Date.now()}`;
  await app.page.getByTestId("comment-input").fill(text);
  await app.page.getByTestId("comment-send").evaluate((b: HTMLButtonElement) => {
    b.click();
    b.click();
    b.click();
  });
  await expect(app.page.getByTestId("timeline-entry").filter({ hasText: text })).not.toHaveCount(0, { timeout: 15_000 });
  await app.page.waitForTimeout(2500);
  await expect(app.page.getByTestId("timeline-entry").filter({ hasText: text })).toHaveCount(1);
});

test("D24 a double tap on Create task creates one task", async () => {
  await nav("Tasks");
  await app.page.getByTestId("new-task").click();
  const title = `double-submit ${Date.now()}`;
  await app.page.getByTestId("task-title").fill(title);
  await app.page.getByTestId("task-submit").evaluate((b: HTMLButtonElement) => {
    b.click();
    b.click();
  });
  await expect(app.page.getByTestId("detail-title")).toHaveText(title, { timeout: 20_000 });
  await nav("Tasks");
  await app.page.getByTestId("chip-open").click();
  await app.page.waitForTimeout(2000);
  await expect(app.page.getByTestId("task-row").filter({ hasText: title })).toHaveCount(1);
});

// ── H51 markup in user text, deep links ──────────────────────────────────────

test("H51 markup in a title and a comment renders as text; crafted links are ignored", async () => {
  const evil = `<img src=x onerror="window.__xss=1"><b>bold</b> <script>window.__xss=2</script>`;
  await nav("Tasks");
  await app.page.getByTestId("new-task").click();
  await app.page.getByTestId("task-title").fill(evil.slice(0, 120));
  await app.page.getByTestId("task-submit").click();
  await expect(app.page.getByTestId("detail-title")).toContainText("<img src=x", { timeout: 20_000 });
  await app.page.getByTestId("comment-input").fill(evil);
  await app.page.getByTestId("comment-send").click();
  await expect(app.page.getByTestId("timeline-entry").filter({ hasText: "<script>" })).toBeVisible();
  expect(await app.page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  expect(await app.page.locator('img[src="x"], .tl-text b, .tl-text script').count()).toBe(0);

  // links the app does not own must not resolve to it, and a link it does own with junk must not navigate/crash
  const before = await hash();
  const unknown = await app.shell(`am start -a android.intent.action.VIEW -p ${PKG} -d 'ffm://tasks/..%2F..%2Fadmin' 2>&1`);
  console.log("custom-scheme link:", unknown.trim().split("\n").slice(-1)[0]);
  await app.shell(`am start -a android.intent.action.VIEW -p ${PKG} -d 'https://${linkDomain()}/finish-sign-in?mode=signIn&oobCode=junk&apiKey=x#/more' 2>&1`);
  await app.page.waitForTimeout(2000);
  await expect(tabs()).toBeVisible();
  expect(app.pageErrors.filter((e) => /xss|Unhandled/i.test(e))).toEqual([]);
  console.log(`route before/after links: ${before} -> ${await hash()}`);
});

// ── long text and emoji ──────────────────────────────────────────────────────

test("I long titles, unbroken strings and emoji stay inside the screen (tablet and phone)", async () => {
  const emoji = "👷‍♂️🏗️ Grieta ñ — 日本語 العربية";
  const unbroken = "A".repeat(150);
  await nav("Tasks");
  for (const [i, title] of [`${emoji} ${"largo ".repeat(14)}`.slice(0, 140), unbroken].entries()) {
    await app.page.getByTestId("new-task").click();
    await app.page.getByTestId("task-title").fill(title);
    await app.page.getByTestId("task-description").fill(`${unbroken}${unbroken}\n${emoji}`);
    await app.page.getByTestId("task-submit").click();
    await expect(app.page.getByTestId("detail-title")).toContainText(title.slice(0, 20), { timeout: 20_000 });
    if (i === 0) expect(await app.page.getByTestId("detail-title").textContent()).toContain("👷‍♂️");
    const detail = await noHorizontalOverflow(app.page);
    console.log(`detail overflow (${i}):`, detail.offenders.join(" ; "));
    await app.shot(`qa-longtext-detail-${i}`);
    expect(detail.ok, `detail overflows: ${detail.offenders.join(" ; ")}`).toBe(true);
    await nav("Tasks");
  }
  const list = await noHorizontalOverflow(app.page);
  console.log("list overflow:", list.offenders.join(" ; "));
  await app.shot("qa-longtext-list");
  expect(list.ok, `list overflows: ${list.offenders.join(" ; ")}`).toBe(true);

  await app.shell("wm size 1080x2340");
  await app.shell("wm density 440");
  await expect(app.page.locator(".shell")).toHaveAttribute("data-layout", "phone", { timeout: 30_000 }).catch(async () => {
    // activity recreation on density change: re-attach
    await new Promise((r) => setTimeout(r, 4000));
    await reattach();
  });
  const phone = await noHorizontalOverflow(app.page);
  await app.shot("qa-longtext-phone-list");
  await app.shell("wm size reset");
  await app.shell("wm density reset");
  await new Promise((r) => setTimeout(r, 4000));
  await reattach();
  expect(phone.ok, `phone list overflows: ${phone.offenders.join(" ; ")}`).toBe(true);
});

// ── I54 font scale, dark/light ───────────────────────────────────────────────

test("I54 font scale 1.3 on a phone: the create form stays usable; the app stays light and legible in OS dark mode", async () => {
  await setFontScale(app, 1.3);
  await app.shell("wm size 1080x2340");
  await app.shell("wm density 440");
  await new Promise((r) => setTimeout(r, 5000));
  await reattach();
  await expect(tabs()).toBeVisible({ timeout: 30_000 });
  await nav("Tasks");
  await app.page.getByTestId("new-task").click();
  await app.shot("qa-i54-font13-form");
  const o = await noHorizontalOverflow(app.page);
  expect(o.ok, o.offenders.join(" ; ")).toBe(true);
  // the New task screen is focused (no tab bar); its Create bar stays on screen with the larger text
  await expect(tabs()).toHaveCount(0);
  const submit = app.page.getByTestId("task-submit");
  const sb = (await submit.boundingBox())!;
  expect(sb.y + sb.height).toBeLessThanOrEqual((await app.page.evaluate(() => window.innerHeight)) + 1);
  expect(sb.height).toBeGreaterThanOrEqual(43.5);
  // Light-only app: an OS night mode must not invert anything (color-scheme: light, no dark styles).
  const probe = () =>
    app.page.evaluate(() => {
      const cs = (el: Element) => getComputedStyle(el);
      const lum = (c: string) => {
        const m = c.match(/\d+(\.\d+)?/g)!.map(Number);
        return (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) / 255;
      };
      const body = cs(document.body);
      return {
        bg: body.backgroundColor,
        text: body.color,
        bgLum: lum(body.backgroundColor),
        textLum: lum(body.color),
        scheme: cs(document.documentElement).colorScheme,
        appBg: cs(document.documentElement).getPropertyValue("--ff-bg-app").trim(),
      };
    });
  await setNight(app, false);
  await app.page.waitForTimeout(1500);
  const day = await probe();
  await setNight(app, true);
  await app.page.waitForTimeout(1500);
  const night = await probe();
  await app.shot("qa-i54-night");
  console.log(`body day ${JSON.stringify(day)} night ${JSON.stringify(night)}`);
  expect(night.bg).toBe(day.bg);
  expect(night.text).toBe(day.text);
  expect(night.scheme).toBe("light");
  expect(night.bgLum).toBeGreaterThan(0.9); // light background
  expect(night.textLum).toBeLessThan(0.4); // dark text: legible
  expect(night.bgLum - night.textLum).toBeGreaterThan(0.5);
  await app.page.getByTestId("task-discard").click();
  await setFontScale(app, null);
  await setNight(app, false);
  await app.shell("wm size reset");
  await app.shell("wm density reset");
  await new Promise((r) => setTimeout(r, 4000));
  await reattach();
});

// ── I55 / E34 rotation keeps state ───────────────────────────────────────────

test("I55 rotating the device with the form open keeps the typed text and does not reload the page", async () => {
  await nav("Tasks");
  await app.page.getByTestId("new-task").click();
  await app.page.getByTestId("task-title").fill("Rotation test title");
  await app.page.getByTestId("task-description").fill("typed before rotating");
  const origin = await app.page.evaluate(() => performance.timeOrigin);
  for (const rot of [1, 0, 3, 0] as const) {
    await setRotation(app, rot);
    await app.page.waitForTimeout(2500);
    await expect(app.page.getByTestId("task-title")).toHaveValue("Rotation test title");
    await expect(app.page.getByTestId("task-description")).toHaveValue("typed before rotating");
    if (rot === 1) await app.shot("qa-i55-landscape-form");
  }
  expect(await app.page.evaluate(() => performance.timeOrigin)).toBe(origin);
  await app.page.getByTestId("task-discard").click();
});

// ── B8 background kill ───────────────────────────────────────────────────────

test("B8 `am kill` in the background right after typing keeps the draft (flush on hide)", async () => {
  await nav("Tasks");
  await app.page.getByTestId("new-task").click();
  await app.page.getByTestId("task-title").fill("Killed in background");
  await app.page.getByTestId("task-description").fill("typed less than a second before HOME");
  await app.shell("input keyevent KEYCODE_HOME");
  await new Promise((r) => setTimeout(r, 1500));
  await app.shell(`am kill ${PKG}`);
  const alive = (await app.shell(`pidof ${PKG}`)).trim();
  console.log("pid after am kill:", alive || "(gone)");
  await relaunch();
  await nav("Tasks");
  await app.page.getByTestId("folder-drafts").click();
  const row = app.page.getByTestId("draft-row").filter({ hasText: "Killed in background" });
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.click();
  await expect(app.page.getByTestId("task-description")).toHaveValue("typed less than a second before HOME");
  await app.page.getByTestId("task-discard").click();
});

// ── G42 permission revoked while the form is open ────────────────────────────

test("G42 camera permission revoked while composing: the draft survives and the denial is explained", async () => {
  await app.shell(`pm grant ${PKG} android.permission.CAMERA`);
  await nav("Tasks");
  await app.page.getByTestId("new-task").click();
  await app.page.getByTestId("task-title").fill("Revoked while open");
  await expect(app.page.getByTestId("draft-status")).toHaveAttribute("data-saved", "1", { timeout: 10_000 });
  const pidBefore = (await app.shell(`pidof ${PKG}`)).trim();
  await app.shell(`pm revoke ${PKG} android.permission.CAMERA`); // the OS kills the process, asynchronously
  // wait for that kill: reattaching to the dying process hands the test a page that closes under it
  await expect.poll(async () => (await app.shell(`pidof ${PKG}`)).trim() !== pidBefore, { timeout: 15_000 }).toBe(true);
  await app.shell(`am start -n ${ACTIVITY}`);
  await reattach();
  await expect(tabs()).toBeVisible({ timeout: 60_000 });
  await nav("Tasks");
  await app.page.getByTestId("folder-drafts").click();
  await app.page.getByTestId("draft-row").filter({ hasText: "Revoked while open" }).click();
  await app.page.getByTestId("photo-camera").click();
  await tapSys(app, /permission_deny_button|Don.t allow|Deny/i, 20_000).catch(() => undefined);
  const msg = app.page.getByTestId("photo-message");
  await expect(msg).toBeVisible({ timeout: 30_000 });
  await app.shot("qa-g42-denied");
  // the message must offer a way to the settings screen, and the gallery must still work
  await expect(app.page.getByTestId("photo-open-settings")).toBeVisible();
  await expect(app.page.getByTestId("photo-gallery")).toBeEnabled();
  await expect(app.page.getByTestId("task-title")).toHaveValue("Revoked while open");
  await app.page.getByTestId("task-discard").click();
});

// ── photos: gallery deletion, large EXIF-rotated image, low storage ──────────

function makeJpeg(w: number, h: number, orientation: number): string | null {
  const out = join(SHOTS, `qa-${w}x${h}-o${orientation}.jpg`);
  try {
    execFileSync(
      "python3",
      [
        "-I",
        "-c",
        `
from PIL import Image
import sys
w,h,o,out=int(sys.argv[1]),int(sys.argv[2]),int(sys.argv[3]),sys.argv[4]
im=Image.new("RGB",(w,h),(120,140,160))
px=im.load()
for x in range(0,w,max(1,w//64)):
    for y in range(0,h): px[x,y]=(220,60,60)
for y in range(0,h//8):
    for x in range(0,w//4): px[x,y]=(20,200,20)   # green block marks the top-left of the stored image
ex=Image.Exif(); ex[0x0112]=o
im.save(out,"JPEG",quality=60,exif=ex)
`,
        String(w),
        String(h),
        String(orientation),
        out,
      ],
      { stdio: "pipe" },
    );
    return out;
  } catch (e) {
    console.log("PIL unavailable; skipping image fixture", String(e).slice(0, 120));
    return null;
  }
}

async function pushAndPick(local: string, name: string) {
  await app.device.push(local, `/sdcard/Pictures/${name}`);
  await app.shell(`am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file:///sdcard/Pictures/${name}`);
  await app.page.getByTestId("photo-gallery").click();
  await app.page.waitForTimeout(3000);
  await tapSys(app, /^Photo taken on|^Image:|ffm-/i, 45_000).catch(async () => {
    await tapSys(app, /thumbnail|icon_thumb|image/i, 20_000);
  });
}

test("C16 a photo deleted from the gallery after it was attached still goes with the task", async () => {
  await app.shell(`pm grant ${PKG} android.permission.CAMERA`);
  const jpg = makeJpeg(1600, 1200, 1);
  test.skip(!jpg, "no PIL");
  await nav("Tasks");
  await app.page.getByTestId("new-task").click();
  await app.page.getByTestId("task-title").fill("Gallery photo deleted");
  await pushAndPick(jpg!, "ffm-qa-c16.jpg");
  await expect(app.page.getByTestId("photo-tile")).toHaveCount(1, { timeout: 60_000 });
  await app.shell("rm -f /sdcard/Pictures/ffm-qa-c16.jpg; content delete --uri content://media/external/images/media --where \"_display_name='ffm-qa-c16.jpg'\"");
  await app.page.getByTestId("task-submit").click();
  await expect(app.page.getByTestId("task-photos").getByTestId("task-photo")).toHaveCount(1, { timeout: 30_000 });
  const ok = await app.page.getByTestId("task-photos").locator("img").first().evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0);
  expect(ok).toBe(true);
});

test("D22 a 24 MP photo with EXIF orientation 6 is stored upright and downscaled without crashing", async () => {
  const jpg = makeJpeg(6000, 4000, 6);
  test.skip(!jpg, "no PIL");
  await nav("Tasks");
  await app.page.getByTestId("new-task").click();
  await app.page.getByTestId("task-title").fill("Big rotated photo");
  const origin = await app.page.evaluate(() => performance.timeOrigin);
  await pushAndPick(jpg!, "ffm-qa-d22.jpg");
  await expect(app.page.getByTestId("photo-tile")).toHaveCount(1, { timeout: 120_000 });
  expect(await app.page.evaluate(() => performance.timeOrigin), "renderer must not have been reloaded by an OOM").toBe(origin);
  const dims = await app.page.getByTestId("photo-tile").locator("img").first().evaluate((i: HTMLImageElement) => ({ w: i.naturalWidth, h: i.naturalHeight }));
  console.log("stored photo:", JSON.stringify(dims));
  expect(dims.w).toBeLessThanOrEqual(2560);
  expect(dims.h).toBeLessThanOrEqual(2560);
  expect(dims.h, "EXIF orientation 6 (rotate 90) must turn a landscape file upright").toBeGreaterThan(dims.w);
  await app.page.getByTestId("task-discard").click();
});

test("C14 low storage: adding a photo fails with a clear message, the draft is intact, the app keeps working", async () => {
  test.skip(!rooted, "needs a root shell to fill /data");
  const jpg = makeJpeg(1600, 1200, 1);
  test.skip(!jpg, "no PIL");
  await nav("Tasks");
  await app.page.getByTestId("new-task").click();
  await app.page.getByTestId("task-title").fill("Storage nearly full");
  // earlier tests (C16 deletes its picture, D22 adds one) leave stale MediaStore rows: the picker would offer a "No such image found"
  // entry first. Start from an empty gallery so the only picture is this one.
  await app.shell("rm -f /sdcard/Pictures/ffm-qa-*.jpg /sdcard/Pictures/ffm-*.jpg");
  await app.shell("content delete --uri content://media/external/images/media").catch(() => undefined);
  await app.device.push(jpg!, "/sdcard/Pictures/ffm-qa-c14.jpg");
  await app.shell("am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file:///sdcard/Pictures/ffm-qa-c14.jpg");
  // Open the picker first (the system media provider needs free space of its own to start), then fill /data down to ~1.5 MB
  // and choose the picture: the failure then happens in the app's copy/process/store step, which is what C14 is about.
  await app.page.getByTestId("photo-gallery").click();
  await app.page.waitForTimeout(3000);
  const df = (await app.shell("df -k /data | tail -1")).trim().split(/\s+/);
  const freeKb = Number(df[3]);
  const fillKb = Math.max(0, freeKb - 1536);
  await app.shell(`dd if=/dev/zero of=${APP_FILLER} bs=1024 count=${fillKb} 2>&1 | tail -1`);
  console.log(`free before ${freeKb} KB, after`, (await app.shell("df -k /data | tail -1")).trim());
  try {
    await tapSys(app, /^Photo taken on|^Image:|ffm-/i, 45_000).catch(() => undefined);
    const msg = app.page.getByTestId("photo-message");
    await expect(msg.or(app.page.getByTestId("photo-tile"))).toBeVisible({ timeout: 60_000 });
    const text = (await msg.textContent().catch(() => null)) ?? "";
    console.log("low-storage message:", JSON.stringify(text));
    await app.shot("qa-c14-low-storage");
    expect(text, "the failure must be specific, not the raw plugin error").toMatch(/storage|space|full/i);
    await expect(app.page.getByTestId("task-title")).toHaveValue("Storage nearly full");
  } finally {
    await app.shell(`rm -f ${APP_FILLER}`);
  }
  await expect(app.page.getByTestId("task-title")).toBeVisible();
  await app.page.getByTestId("task-discard").click();
  await expect(app.page.getByTestId("tasks-list-pane")).toBeVisible();
});

// ── I59 time zone ────────────────────────────────────────────────────────────

test("I59 'Today' as a deadline is the local calendar day in a far-east and a far-west time zone", async () => {
  test.skip(!rooted, "needs a root shell to change the time zone");
  const utcHour = new Date().getUTCHours();
  // pick the zone whose local date differs from the UTC date right now
  const tz = utcHour >= 10 ? "Pacific/Kiritimati" : "Etc/GMT+12";
  await app.shell("settings put global auto_time_zone 0");
  await app.shell(`setprop persist.sys.timezone ${tz}`);
  await app.shell(`service call alarm 3 s16 ${tz}`).catch(() => undefined);
  await relaunch();
  const tzNow = await app.page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  console.log(`time zone in the WebView: ${tzNow} (wanted ${tz})`);
  test.skip(tzNow !== tz, "emulator did not switch the zone");
  await nav("Tasks");
  await app.page.getByTestId("new-task").click();
  await app.page.getByTestId("task-title").fill("Deadline today in far zone");
  await app.page.getByRole("button", { name: "Today" }).click();
  const shown = await app.page.getByTestId("task-deadline").inputValue();
  const localToday = await app.page.evaluate(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  });
  console.log(`date input ${shown}, local calendar day ${localToday}`);
  await app.shot("qa-i59-timezone");
  await app.page.getByTestId("task-discard").click();
  await app.shell("settings put global auto_time_zone 1");
  await app.shell("setprop persist.sys.timezone UTC");
  expect(shown).toBe(localToday);
});
