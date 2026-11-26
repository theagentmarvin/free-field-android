import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { launchApp, PKG, type AppSession } from "./app";
import { setRotation } from "./qa";
import { snapUi, sysVisible, tapSys } from "./sysui";

/**
 * On-device task notifications. "Remote" changes are written into the demo task store as another user (the app's own sync
 * listeners then fire exactly as for a server change); we check the Android notification shade, not the WebView.
 */
test.describe.configure({ mode: "serial" });
test.setTimeout(240_000);

const DOCS = join(process.cwd(), "docs/spikes/notifications");
let app: AppSession;
let taskId = "";

type Remote = { taskId?: string; action: "create" | "assign" | "comment" | "complete"; title?: string; text?: string; assignToMe?: boolean; deadline?: number | null; by?: { uid: string; name: string }; asMe?: boolean };

const remote = (spec: Remote) => app.page.evaluate((s) => window.__ffmTest!.simulateRemote(s), spec);

/** `dumpsys notification` titles+text of this app's posted notifications. */
async function posted(): Promise<string> {
  const out = await app.shell("dumpsys notification --noredact");
  const blocks = out.split(/\n\s*NotificationRecord\(/).filter((b) => b.includes(`pkg=${PKG}`));
  return blocks.map((b) => [/android\.title=\S+ \((.*)\)/.exec(b)?.[1], /android\.text=\S+ \((.*)\)/.exec(b)?.[1]].filter(Boolean).join(" | ")).join("\n");
}

async function waitPosted(re: RegExp, timeoutMs = 25_000): Promise<string> {
  const end = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < end) {
    last = await posted();
    if (re.test(last)) return last;
    await new Promise((r) => setTimeout(r, 750));
  }
  await snapUi(app, `no-notification-${Date.now()}`).catch(() => undefined);
  console.log((await app.shell(`dumpsys package ${PKG} | grep -i POST_NOTIFICATIONS`).catch(() => "")) + (await app.shell("dumpsys notification --noredact | head -60").catch(() => "")));
  throw new Error(`notification ${re} not posted; shade has:\n${last || "(nothing)"}`);
}

async function shade(name: string) {
  await app.shell("cmd statusbar expand-notifications");
  await new Promise((r) => setTimeout(r, 1500));
  await app.device.screenshot({ path: join(DOCS, `${name}.png`) });
  await closeShade();
}

/** Pull the shade down until `want` is on screen: a pull right after a collapse is sometimes ignored. */
async function openShade(want: RegExp) {
  for (let i = 0; i < 4; i++) {
    await app.shell("cmd statusbar expand-notifications");
    await new Promise((r) => setTimeout(r, 1500));
    if (await sysVisible(app, want)) return;
    await closeShade();
  }
}

async function closeShade() {
  await app.shell("cmd statusbar collapse");
  await new Promise((r) => setTimeout(r, 600));
}

async function shot(name: string) {
  await app.page.screenshot({ path: join(DOCS, `${name}.png`), timeout: 10_000 }).catch(() => undefined);
}

async function openMore() {
  await app.page.getByTestId("tabs").getByRole("link", { name: "More", exact: true }).click();
  await expect(app.page.getByTestId("notify-settings")).toBeVisible();
}

async function openTasks() {
  await app.page.getByTestId("tabs").getByRole("link", { name: "Tasks", exact: true }).click();
  await expect(app.page.getByTestId("tasks-list-pane")).toBeVisible();
}

test.beforeAll(async () => {
  mkdirSync(DOCS, { recursive: true });
  app = await launchApp();
  app.page.on("console", (m) => {
    if (m.text().includes("[notify]")) console.log(`page: ${m.text()}`);
  });
  await app.shell("cmd notification set_dnd off").catch(() => undefined);
});
test.afterAll(async () => {
  if (app) await setRotation(app, 0).catch(() => undefined);
  await app?.close();
});

test("sign in; nothing is asked or shown at launch", async () => {
  await app.page.getByTestId("demo-signin").click();
  const picker = app.page.getByTestId("project-picker");
  const tabs = app.page.getByTestId("tabs");
  await expect(picker.or(tabs)).toBeVisible();
  if (await picker.isVisible()) await app.page.getByTestId("project-default-project").click();
  await expect(tabs).toBeVisible();
  await openTasks();
  // The first sync (demo seed) is the initial download: it must stay silent, and no permission dialog may appear.
  await new Promise((r) => setTimeout(r, 7000));
  expect(await posted()).toBe("");
  expect(await sysVisible(app, /Allow|permission_allow/i)).toBe(false);
  expect(await app.shell(`dumpsys package ${PKG}`)).toMatch(/POST_NOTIFICATIONS/);
});

test("settings: master switch and one switch per category", async () => {
  await openMore();
  for (const id of ["notify-master", "notify-assigned", "notify-status", "notify-comments", "notify-deadlines"]) {
    await expect(app.page.getByTestId(id)).toHaveAttribute("aria-checked", "true");
  }
  await shot("01-settings");
});

test("a task assigned to me raises a notification; permission is requested in context", async () => {
  taskId = await remote({ action: "create", title: "Verify rebar spacing at B4", assignToMe: true });
  // the Android 13+ runtime dialog appears now, the first time there is something to tell
  // The dialog animates in; a tap during the animation can be lost, so confirm the grant and retry.
  for (let attempt = 0; attempt < 4; attempt++) {
    console.log(`permission dialog: tapped ${await tapSys(app, /permission_allow_button|^Allow$/i, 45_000)}`);
    await new Promise((r) => setTimeout(r, 1500));
    if (/POST_NOTIFICATIONS: granted=true/.test(await app.shell(`dumpsys package ${PKG}`))) break;
  }
  expect(await app.shell(`dumpsys package ${PKG}`)).toMatch(/POST_NOTIFICATIONS: granted=true/);
  const text = await waitPosted(/T\d+ assigned to you \| Verify rebar spacing at B4/);
  expect(text).toContain("by Ana Silva");
  await shade("02-shade-assigned");
});

test("tapping the notification opens that task", async () => {
  await openShade(/assigned to you/i);
  await tapSys(app, /assigned to you/i);
  await expect.poll(() => app.page.evaluate(() => window.location.hash)).toContain(`/tasks/${taskId}`);
  await expect(app.page.getByText("Verify rebar spacing at B4").first()).toBeVisible();
  await shot("03-opened-task");
  await new Promise((r) => setTimeout(r, 1000));
  expect(await posted()).not.toMatch(/assigned to you/); // autoCancel removed it
});

test("a tap for a project the user has left says so and stays put", async () => {
  // The demo has one project, so a "different member project" switch is covered by unit tests (tapRoute.test.ts); here we
  // press the seam with a project the user does not belong to.
  await openTasks();
  await app.page.evaluate(() => window.__ffmTest!.tapNotification({ path: "/tasks/whatever", projectId: "project-the-user-left" }));
  await expect(app.page.getByTestId("notify-notice")).toContainText(/no longer have access/i);
  expect(await app.page.evaluate(() => window.location.hash)).toMatch(/#\/tasks$/);
  await shot("03b-not-member-notice");
});

test("a comment addressed to me and a status change notify; my own edits do not", async () => {
  await remote({ taskId, action: "comment", text: "@Alex Rivera can you confirm the cover depth?" });
  await waitPosted(/mentioned you in T\d+ \| @Alex Rivera can you confirm/);
  await remote({ taskId, action: "complete" });
  await waitPosted(/moved to Awaiting approval/);
  // same action by the signed-in user: no new notification
  await remote({ taskId, action: "comment", text: "my own note", asMe: true });
  await new Promise((r) => setTimeout(r, 3500));
  expect(await posted()).not.toMatch(/my own note/);
  await shade("04-shade-mention-status");
});

test("a burst becomes one grouped summary that opens the list", async () => {
  await openTasks();
  for (let i = 1; i <= 5; i++) await remote({ taskId, action: "comment", text: `burst comment ${i}` });
  const text = await waitPosted(/5 task updates in /);
  expect(text).not.toMatch(/burst comment 3 \|/); // no individual notifications for the burst
  await shade("05-shade-summary");
  await openShade(/5 task updates in/i);
  await tapSys(app, /5 task updates in/i);
  await expect.poll(() => app.page.evaluate(() => window.location.hash)).toMatch(/#\/tasks$/);
  await shot("06-opened-list");
});

test("a deadline today raises a reminder, once", async () => {
  await remote({ action: "create", title: "Hand over level 2 snag list", assignToMe: true, deadline: Date.now() + 3_600_000 });
  await waitPosted(/is due today \| Hand over level 2 snag list/);
  await shade("07-shade-deadline");
});

test("the comments switch silences comments; the master switch silences everything", async () => {
  await openMore();
  await app.page.getByTestId("notify-comments").click();
  await expect(app.page.getByTestId("notify-comments")).toHaveAttribute("aria-checked", "false");
  await shot("08-settings-comments-off");
  await openTasks();
  await remote({ taskId, action: "comment", text: "muted comment" });
  await new Promise((r) => setTimeout(r, 4000));
  expect(await posted()).not.toMatch(/muted comment/);

  await openMore();
  await app.page.getByTestId("notify-master").click();
  await expect(app.page.getByTestId("notify-assigned")).toBeDisabled();
  await openTasks();
  await remote({ action: "create", title: "Muted assignment", assignToMe: true });
  await new Promise((r) => setTimeout(r, 4000));
  expect(await posted()).not.toMatch(/Muted assignment/);
  await snapUi(app, "notifications-end").catch(() => undefined);
});
