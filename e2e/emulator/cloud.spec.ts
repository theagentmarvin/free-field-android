import { expect, test } from "@playwright/test";
import { launchApp, PKG, waitForTestHooks, type AppSession } from "../app";
import { appLinkFor, listDocs, SEED, setDoc, waitForSignInCode } from "./rest";
import { captureOnFailure, goOnline, ensureOnline, restoreNetwork, setOffline } from "./network";

/**
 * Cloud mode against the Firebase emulators (auth + firestore + storage).
 * One serial story: sign in by e-mail link, pick a project, create tasks online and
 * offline, kill the app with changes pending, sign out. State carries from test to test.
 */
test.describe.configure({ mode: "serial" });

let app: AppSession;
const alpha = SEED.projects[0];
const beta = SEED.projects[1];

const chip = () => app.page.getByTestId("sync-chip");
const tab = (name: string) => app.page.getByTestId("tabs").getByRole("link", { name, exact: true });

async function openLink(url: string) {
  // Explicit package: the OS routes it to our App Link handler without needing verified assetlinks.
  await app.shell(`am start -a android.intent.action.VIEW -p ${PKG} -d '${url}'`);
}

async function signInWithEmailLink(email: string) {
  await app.page.getByTestId("signin-email").fill(email);
  await app.page.getByTestId("signin-submit").click();
  await expect(app.page.getByTestId("signin-sent")).toBeVisible();
  await openLink(appLinkFor(await waitForSignInCode(email)));
}

async function remoteTasks(projectId: string) {
  return (await listDocs(`projects/${projectId}/tasks`)).map((d) => d.data);
}

/** Exactly one remote doc per title: a retry or a second engine must never duplicate a task. */
async function expectSingleRemoteTask(projectId: string, title: string) {
  // Let any (wrongly) duplicated write land before counting.
  await new Promise((r) => setTimeout(r, 4000));
  expect((await remoteTasks(projectId)).filter((t) => t.title === title)).toHaveLength(1);
}

async function waitForRemoteTask(projectId: string, title: string) {
  await expect
    .poll(async () => (await remoteTasks(projectId)).some((t) => t.title === title), { timeout: 60_000, intervals: [1000] })
    .toBe(true);
}

const createTask = async (title: string) => { await waitForTestHooks(app.page); return app.page.evaluate((t) => window.__ffmTest!.createTask(t), title); };
const offline = (on: boolean) => (on ? setOffline(app, true) : goOnline(app, async (p) => (await p.getByTestId("sync-chip").getAttribute("data-state")) === "online"));
captureOnFailure(() => app);

test.beforeAll(async () => {
  await ensureOnline();
  app = await launchApp();
});
test.afterAll(async () => {
  await restoreNetwork(app);
  await app?.close();
});

test("email-link sign-in via the Auth emulator lands on the project picker", async () => {
  await expect(app.page.getByTestId("signin-form")).toBeVisible();
  await signInWithEmailLink(SEED.userMulti.email);
  await expect(app.page.getByTestId("project-picker")).toBeVisible();
  await app.shot("e2e-01-picker");
});

test("picker lists both memberships by name; choosing one opens the shell", async () => {
  await expect(app.page.getByTestId(`project-${alpha.id}`)).toContainText(alpha.name);
  await expect(app.page.getByTestId(`project-${beta.id}`)).toContainText(beta.name);
  await expect(app.page.getByTestId("project-e2e-gamma")).toHaveCount(0); // not a member
  await app.page.getByTestId(`project-${alpha.id}`).click();
  await expect(app.page.getByTestId("tabs")).toBeVisible();
  await expect(app.page.locator("header h1")).toHaveText(alpha.name);
  await expect(chip()).toHaveAttribute("data-state", "online");
});

test("More shows account, project, storage, persistence request, version and logs", async () => {
  await tab("More").click();
  await expect(app.page.getByTestId("account-email")).toHaveText(SEED.userMulti.email);
  await expect(app.page.getByTestId("current-project")).toHaveText(alpha.name);
  await expect(app.page.getByTestId("storage-blobs")).toContainText("files");
  await expect(app.page.getByTestId("storage-persist")).not.toHaveText("pending");
  console.log("storage.persist() result:", await app.page.getByTestId("storage-persist").textContent());
  await expect(app.page.getByTestId("app-version")).not.toHaveText("…");
  await app.page.getByTestId("export-logs").click();
  await expect(app.page.getByTestId("more-note")).toContainText(/Logs (shared|saved)/, { timeout: 15_000 });
  await app.shell("input keyevent KEYCODE_BACK"); // close the system share sheet
  await app.shot("e2e-02-more");
});

test("a task created online reaches Firestore and the list", async () => {
  await tab("Tasks").click();
  await createTask("E2E online task");
  await waitForRemoteTask(alpha.id, "E2E online task");
  await expect(app.page.getByTestId("task-row").filter({ hasText: "E2E online task" })).toBeVisible();
  await expect(chip()).toHaveAttribute("data-pending", "0");
});

test("airplane mode: task stays pending in the outbox, drains when back online", async () => {
  await offline(true);
  await expect(chip()).toHaveAttribute("data-state", "offline", { timeout: 45_000 });
  await createTask("E2E offline task");
  await expect(chip()).toHaveAttribute("data-pending", "1");
  await tab("Sync").click();
  const group = app.page.getByTestId("outbox-group").filter({ hasText: "E2E offline task" });
  await expect(group).toBeVisible();
  await expect(group.getByTestId("outbox-item")).toHaveAttribute("data-state", "added");
  await app.shot("e2e-03-outbox-pending");
  expect((await remoteTasks(alpha.id)).some((t) => t.title === "E2E offline task")).toBe(false);
  await new Promise((r) => setTimeout(r, 5000)); // truly offline: nothing may sneak out over a live tunnel
  expect((await remoteTasks(alpha.id)).some((t) => t.title === "E2E offline task")).toBe(false);
  await expect(group.getByTestId("outbox-item")).toHaveAttribute("data-state", "added");

  await offline(false);
  await expect(chip()).toHaveAttribute("data-state", "online", { timeout: 60_000 });
  await waitForRemoteTask(alpha.id, "E2E offline task");
  await expect(chip()).toHaveAttribute("data-pending", "0");
  await expect(group.getByTestId("outbox-item")).toHaveAttribute("data-state", "sent");
  await expect(group.getByTestId("outbox-item")).toHaveCount(1); // drained exactly once, no duplicate entry
  await expectSingleRemoteTask(alpha.id, "E2E offline task");
  await tab("Tasks").click();
  await expect(app.page.getByTestId("task-row").filter({ hasText: "E2E offline task" })).toHaveCount(1);
});

test("checklist and priority edited offline reach Firestore, and the web's fields round-trip", async () => {
  await tab("Tasks").click();
  const row = app.page.getByTestId("task-row").filter({ hasText: "E2E online task" });
  await row.click();
  await expect(app.page.getByTestId("task-detail")).toBeVisible();
  await offline(true);
  await expect(chip()).toHaveAttribute("data-state", "offline", { timeout: 45_000 });
  await app.page.getByTestId("checklist-new").fill("Check rebar spacing");
  await app.page.getByTestId("checklist-add").click();
  const item = app.page.locator('[data-testid^="checklist-item-"]').first();
  await expect(item).toBeVisible();
  // click + web-first assertion, not `check()`: the checkbox is controlled by the synced task, so its new state lands after the
  // offline outbox write and the live-query round trip (slow on the CPU-rendered emulator), and `check()` verifies the state at once.
  await item.click();
  await expect(item).toBeChecked();
  await app.page.getByTestId("priority-button").click();
  await app.page.getByTestId("priority-high").click();
  await expect(app.page.getByTestId("detail-priority")).toHaveAttribute("data-priority", "high");
  await expect(app.page.getByTestId("detail-checklist")).toHaveAttribute("data-done", "1");
  await expect(chip()).toHaveAttribute("data-pending", /^[1-9]/); // add, check and priority are queued edits
  await app.shot("e2e-03b-checklist-offline");
  const before = (await remoteTasks(alpha.id)).find((t) => t.title === "E2E online task");
  expect((before?.checklist as unknown[] | undefined) ?? []).toHaveLength(0); // nothing leaves while offline

  await offline(false);
  await expect(chip()).toHaveAttribute("data-state", "online", { timeout: 60_000 });
  await expect(chip()).toHaveAttribute("data-pending", "0", { timeout: 60_000 });
  const remoteDoc = async () => (await listDocs(`projects/${alpha.id}/tasks`)).find((d) => d.data.title === "E2E online task");
  const remote = async () => (await remoteDoc())?.data;
  await expect.poll(async () => ((await remote())?.checklist as Array<{ text: string; done: boolean }> | undefined)?.[0]?.done, { timeout: 60_000 }).toBe(true);
  const doc = await remote();
  expect((doc?.checklist as Array<{ text: string }>)[0].text).toBe("Check rebar spacing");
  expect(doc?.priority).toBe("high");

  // the other direction: a change made on the web side (here: straight into Firestore) shows on the tablet
  const web = { ...(doc as Record<string, unknown>), checklist: [{ id: "web-1", text: "Added on the web", done: false }, ...((doc?.checklist as unknown[]) ?? [])] };
  await setDoc(`projects/${alpha.id}/tasks/${(await remoteDoc())!.id}`, web);
  await expect(app.page.getByText("Added on the web")).toBeVisible({ timeout: 30_000 });
  await app.page.getByTestId("task-back").click();
});

test("kill the app with a change pending: session persists offline, relaunch drains", async () => {
  await offline(true);
  await expect(chip()).toHaveAttribute("data-state", "offline", { timeout: 45_000 });
  await createTask("E2E killed task");
  await expect(chip()).toHaveAttribute("data-pending", "1");
  await app.device.shell(`am force-stop ${PKG}`);

  // Relaunch still offline: persisted session (no sign-in), persisted pending row.
  await app.device.close();
  app = await launchApp({ clear: false });
  await expect(app.page.getByTestId("tabs")).toBeVisible({ timeout: 60_000 });
  await expect(app.page.getByTestId("signin-form")).toHaveCount(0);
  await expect(chip()).toHaveAttribute("data-state", "offline");
  await expect(chip()).toHaveAttribute("data-pending", "1");
  expect((await remoteTasks(alpha.id)).some((t) => t.title === "E2E killed task")).toBe(false);

  await offline(false);
  await waitForRemoteTask(alpha.id, "E2E killed task");
  await expect(chip()).toHaveAttribute("data-pending", "0", { timeout: 60_000 });
  await expectSingleRemoteTask(alpha.id, "E2E killed task");
  await app.shot("e2e-04-after-kill");
});

test("sign-out warns about unsynced changes, wipes local data, other user auto-picks", async () => {
  await offline(true);
  await expect(chip()).toHaveAttribute("data-state", "offline", { timeout: 45_000 });
  await createTask("E2E unsynced task");
  await tab("More").click();
  await app.page.getByTestId("signout").click();
  await expect(app.page.getByTestId("signout-warning")).toContainText("1 change");
  await app.page.getByTestId("confirm-cancel").click();
  await expect(app.page.getByTestId("signout-dialog")).toHaveCount(0);

  await offline(false);
  await expect(chip()).toHaveAttribute("data-pending", "0", { timeout: 60_000 });
  await app.page.getByTestId("signout").click();
  await expect(app.page.getByTestId("signout-warning")).toHaveCount(0);
  // Sign-out renders the sign-in form first, wipes local data, and only then reloads the page. Acting on the
  // pre-reload form (the old flake: the e-mail was typed into a page that was about to be thrown away) is a
  // race, so mark this document and wait until the marker is gone, i.e. the reload really happened.
  await app.page.evaluate(() => ((window as unknown as { __preSignOut?: boolean }).__preSignOut = true));
  await app.page.getByTestId("confirm-ok").click();
  await app.page.waitForFunction(() => !(window as unknown as { __preSignOut?: boolean }).__preSignOut, undefined, { timeout: 60_000 });
  await expect(app.page.getByTestId("signin-form")).toBeVisible({ timeout: 60_000 });
  const leftovers = await app.page.evaluate(async () => {
    const dbs = (await indexedDB.databases()).map((d) => d.name ?? "");
    return dbs.filter((n) => /firestore|free-field/i.test(n));
  });
  console.log("IndexedDB after wipe:", JSON.stringify(leftovers));
  expect(await app.page.evaluate(() => window.localStorage.getItem("ff-project-choice"))).toBeNull();

  await signInWithEmailLink(SEED.userSingle.email);
  // Single membership: auto-picked, no picker.
  await expect(app.page.getByTestId("tabs")).toBeVisible({ timeout: 60_000 });
  await expect(app.page.locator("header h1")).toHaveText("Site Gamma");
  await expect(app.page.getByTestId("task-row").filter({ hasText: "E2E" })).toHaveCount(0);
  await app.shot("e2e-05-second-user");
});

test.skip("invitation link redeems through the redeemInvitation callable", async () => {
  // Needs the functions emulator. packages/ff-firestore/functions has no installed
  // dependencies and building it would modify the vendored monorepo, which this repo
  // must not do. Re-enable once the functions bundle is available (see docs/integration).
});
