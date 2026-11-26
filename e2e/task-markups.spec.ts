import { expect, test, type Locator } from "@playwright/test";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { launchApp, SHOTS, touchSession, type AppSession } from "./app";
import { dbg, gotoModel, waitReady } from "./model";
import { setRotation } from "./qa";

/**
 * Task markups (docs/spikes/task-markups.md): "Create markup" in the task detail captures an HD picture of the task's plan pin or 3D
 * view, the user draws on it (one finger draws, two fingers navigate), Accept saves the flattened picture as a task attachment through
 * the offline outbox. Saved markups are fixed: viewed full screen and deleted, never edited.
 */
test.describe.configure({ mode: "serial", timeout: 300_000 });

let app: AppSession;
let touch: Awaited<ReturnType<typeof touchSession>>;
const DOCS = join(process.cwd(), "docs", "spikes", "task-markups");
const S101 = "920118c4-cdb7-4148-a530-b71fe83ca142";

let building = "";
let planTask = "";
let bimTask = "";
let dualTask = "";
let bareTask = "";

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
    await app.shot(`task-markups-fail-${info.title.replace(/\W+/g, "-").slice(0, 40)}`).catch(() => undefined);
  }
});
test.afterAll(async () => {
  await setRotation(app, 0).catch(() => undefined);
  await app?.shell("cmd connectivity airplane-mode disable").catch(() => undefined);
  await touch?.detach().catch(() => undefined);
  await app?.close();
});

async function shotDoc(name: string) {
  await app.shot(name);
  mkdirSync(DOCS, { recursive: true });
  for (const f of [`${name}.png`, `${name}-device.png`]) {
    if (existsSync(join(SHOTS, f))) {
      copyFileSync(join(SHOTS, f), join(DOCS, `${name}.png`));
      return;
    }
  }
}
const goTask = async (id: string) => {
  await app.page.evaluate((h) => {
    window.location.hash = h;
  }, `/tasks/${id}`);
  await expect(app.page.getByTestId("task-detail")).toHaveAttribute("data-task-id", id, { timeout: 30_000 });
};
const markups = () => app.page.getByTestId("task-markup");
const inkCount = async () => Number(await app.page.getByTestId("mk-ink").getAttribute("data-count"));
const stage = async () => (await app.page.getByTestId("mk-stage").boundingBox())!;
const landscape = async () => {
  await setRotation(app, 1);
  await expect.poll(() => app.page.evaluate(() => window.innerWidth > window.innerHeight), { timeout: 20_000 }).toBe(true);
  await app.page.waitForTimeout(1000);
};
const portrait = async () => {
  await setRotation(app, 0);
  await expect.poll(() => app.page.evaluate(() => window.innerWidth < window.innerHeight), { timeout: 20_000 }).toBe(true);
  await app.page.waitForTimeout(1000);
};
const buildingOf = (pdfFileId: string) =>
  app.page.evaluate(
    (id) =>
      new Promise<string>((res, rej) => {
        const open = indexedDB.open("free-field");
        open.onerror = () => rej(open.error);
        open.onsuccess = () => {
          const all = open.result.transaction("pdfFiles", "readonly").objectStore("pdfFiles").getAll();
          all.onsuccess = () => res((all.result as { id: string; buildingId: string }[]).find((f) => f.id === id)!.buildingId);
        };
      }),
    pdfFileId,
  );
const imageSize = (l: Locator) => l.evaluate((i) => ({ w: (i as HTMLImageElement).naturalWidth, h: (i as HTMLImageElement).naturalHeight }));
const registry = () => app.page.evaluate(() => (window as unknown as { __ffmViewerRegistry?: { stats(): { live: number; peak: number; overlaps: number } } }).__ffmViewerRegistry?.stats() ?? null);

/** One-finger drag inside the picture area, positions as fractions of the stage. */
async function stroke(a: [number, number], b: [number, number]) {
  const s = await stage();
  await touch.drag(s.x + s.width * a[0], s.y + s.height * a[1], s.x + s.width * b[0], s.y + s.height * b[1], 10);
  await app.page.waitForTimeout(150);
}
async function pickTool(t: string) {
  await app.page.getByTestId(`mk-tool-${t}`).click();
}

async function openEditor(taskId: string, source?: "plan" | "3d") {
  await goTask(taskId);
  await app.page.getByTestId("task-markup-create").click();
  if (source) await app.page.getByTestId(`mk-choose-${source}`).click();
  await expect(app.page.getByTestId("mk-editor")).toBeVisible({ timeout: source === "3d" || !source ? 240_000 : 90_000 });
  await expect(app.page.getByTestId("mk-image")).toBeVisible();
  await expect.poll(async () => (await imageSize(app.page.getByTestId("mk-image"))).w, { timeout: 30_000 }).toBeGreaterThan(0);
  await expect.poll(async () => Number(await app.page.getByTestId("mk-stage").getAttribute("data-zoom")), { timeout: 10_000 }).toBeGreaterThan(0);
}

test("setup: tasks with a plan pin, a 3D location, both, and none", async () => {
  building = await buildingOf(S101);
  // a world point inside the building: the middle of the loaded models
  await gotoModel(app);
  await waitReady(app.page);
  const boxes = (await dbg(app.page, (d) => d.modelBoxes()))!;
  const mid = [0, 1, 2].map((i) => boxes.reduce((a, b) => a + (b.min[i] + b.max[i]) / 2, 0) / boxes.length);
  await app.page.getByTestId("tabs").getByRole("link", { name: "Tasks", exact: true }).click();
  const make = (title: string, location: unknown) =>
    app.page.evaluate(([t, l, b]) => window.__ffmTest!.createTask(t as string, { buildingId: b as string, location: l as never }), [title, location, building] as const);
  const plan = { storeyName: null, bim: null, pdf: { pdfFileId: S101, page: 1, uv: [0.45, 0.5], calibId: "e2e" } };
  const bim = { storeyName: null, bim: { elements: [], worldPoint: mid, cameraPose: null }, pdf: null };
  planTask = await make("Plan crack", plan);
  bimTask = await make("Model clash", bim);
  dualTask = await make("Plan and model", { ...plan, bim: bim.bim });
  bareTask = await app.page.evaluate(() => window.__ffmTest!.createTask("No location yet"));
});

test("a task without a location has no markup action and explains it on the route", async () => {
  await goTask(bareTask);
  await expect(app.page.getByTestId("task-markup-create")).toHaveCount(0);
  await app.page.evaluate((h) => {
    window.location.hash = h;
  }, `/tasks/${bareTask}/markup`);
  await expect(app.page.getByTestId("mk-needs-location")).toBeVisible();
  await app.page.getByTestId("mk-notice-action").click();
  await expect(app.page.getByTestId("task-detail")).toBeVisible();
});

test("plan markup: HD capture, every tool, colours, undo and redo, pinch zoom and pan, Accept saves an attachment", async () => {
  await openEditor(planTask);
  const sz = await imageSize(app.page.getByTestId("mk-image"));
  console.log("plan capture px", sz);
  expect(Math.max(sz.w, sz.h)).toBeGreaterThanOrEqual(1400);
  expect(Math.max(sz.w, sz.h)).toBeLessThanOrEqual(2400);
  expect(await registry()).toMatchObject({ live: 0 }); // the plan flow never mounts a viewer
  await shotDoc("01-plan-capture");

  // one tool after the other, one stroke each
  await pickTool("pen");
  await stroke([0.2, 0.25], [0.4, 0.4]);
  await expect.poll(inkCount).toBe(1);
  await pickTool("highlight");
  await stroke([0.2, 0.55], [0.6, 0.55]);
  await expect.poll(inkCount).toBe(2);
  await pickTool("arrow");
  await stroke([0.7, 0.2], [0.5, 0.4]);
  await expect.poll(inkCount).toBe(3);
  await pickTool("rect");
  await stroke([0.55, 0.5], [0.8, 0.7]);
  await expect.poll(inkCount).toBe(4);
  await pickTool("ellipse");
  await stroke([0.1, 0.6], [0.3, 0.85]);
  await expect.poll(inkCount).toBe(5);
  await pickTool("cloud");
  await stroke([0.35, 0.65], [0.5, 0.85]);
  await expect.poll(inkCount).toBe(6);
  await pickTool("text");
  const s = await stage();
  await touch.tap(s.x + s.width * 0.6, s.y + s.height * 0.15);
  await expect(app.page.getByTestId("mk-text-sheet")).toBeVisible();
  await app.page.getByTestId("mk-text-input").fill("Re-pour slab");
  await app.page.getByTestId("mk-text-ok").click();
  await expect.poll(inkCount).toBe(7);
  const kinds = await app.page.getByTestId("mk-ink-item").evaluateAll((els) => els.map((e) => e.getAttribute("data-kind")));
  expect(kinds).toEqual(["pen", "highlight", "arrow", "rect", "ellipse", "cloud", "text"]);
  await shotDoc("02-plan-all-tools");

  // colour and width
  await app.page.getByTestId("mk-style").click();
  await app.page.getByTestId("mk-colour-blue").click();
  await app.page.getByTestId("mk-width-thick").click();
  await expect(app.page.getByTestId("mk-editor")).toHaveAttribute("data-colour", "#2563eb");
  await shotDoc("03-style-popover");
  await app.page.getByTestId("mk-style").click();
  await pickTool("pen");
  await stroke([0.05, 0.1], [0.3, 0.12]);
  await expect.poll(inkCount).toBe(8);
  await expect(app.page.getByTestId("mk-ink-item").last().locator("path")).toHaveAttribute("stroke", "#2563eb");

  // undo / redo
  await app.page.getByTestId("mk-undo").click();
  await expect.poll(inkCount).toBe(7);
  await app.page.getByTestId("mk-undo").click();
  await expect.poll(inkCount).toBe(6);
  await app.page.getByTestId("mk-redo").click();
  await app.page.getByTestId("mk-redo").click();
  await expect.poll(inkCount).toBe(8);
  await expect(app.page.getByTestId("mk-redo")).toBeDisabled();

  // two fingers zoom and pan, one finger still draws
  const z0 = Number(await app.page.getByTestId("mk-stage").getAttribute("data-zoom"));
  const t0 = Number(await app.page.getByTestId("mk-stage").getAttribute("data-tx"));
  await touch.pinch(s.x + s.width / 2, s.y + s.height / 2, 120, 420);
  await expect.poll(async () => Number(await app.page.getByTestId("mk-stage").getAttribute("data-zoom"))).toBeGreaterThan(z0 * 1.5);
  expect(await inkCount()).toBe(8); // the pinch drew nothing
  await touch.twoFingerPan(s.x + s.width / 2, s.y + s.height / 2, 160, -120, 0);
  await expect.poll(async () => Number(await app.page.getByTestId("mk-stage").getAttribute("data-tx"))).not.toBe(t0);
  expect(await inkCount()).toBe(8);
  await stroke([0.4, 0.4], [0.6, 0.5]);
  await expect.poll(inkCount).toBe(9);
  await shotDoc("04-zoomed-drawing");
  await app.page.getByTestId("mk-fit").click();
  await expect.poll(async () => Number(await app.page.getByTestId("mk-stage").getAttribute("data-zoom"))).toBeCloseTo(z0, 2);

  // Accept: back on the task, one markup with the badge
  await app.page.getByTestId("mk-accept").click();
  await expect(app.page.getByTestId("task-detail")).toBeVisible({ timeout: 60_000 });
  await expect(markups()).toHaveCount(1, { timeout: 30_000 });
  await expect(markups().first().getByTestId("markup-badge")).toHaveText("Markup");
  await expect(app.page.getByTestId("timeline-markup").first()).toContainText("Added a markup");
  await shotDoc("05-task-with-markup");
});

test("several markups on one task, each its own attachment", async () => {
  await openEditor(planTask);
  await pickTool("arrow");
  await stroke([0.2, 0.2], [0.7, 0.6]);
  await expect.poll(inkCount).toBe(1);
  await app.page.getByTestId("mk-accept").click();
  await expect(app.page.getByTestId("task-detail")).toBeVisible({ timeout: 60_000 });
  await expect(markups()).toHaveCount(2, { timeout: 30_000 });
  const keys = await markups().evaluateAll((els) => els.map((e) => e.getAttribute("data-key")));
  expect(new Set(keys).size).toBe(2);
  await shotDoc("06-two-markups");
});

test("Cancel with a drawing asks first; Discard leaves nothing behind", async () => {
  await openEditor(planTask);
  await stroke([0.2, 0.2], [0.5, 0.5]);
  await expect.poll(inkCount).toBe(1);
  await app.page.getByTestId("mk-cancel").click();
  await expect(app.page.getByTestId("mk-discard-dialog")).toBeVisible();
  await app.page.getByTestId("confirm-cancel").click();
  await expect(app.page.getByTestId("mk-editor")).toBeVisible();
  await app.page.getByTestId("mk-cancel").click();
  await app.page.getByTestId("confirm-ok").click();
  await expect(app.page.getByTestId("task-detail")).toBeVisible();
  await expect(markups()).toHaveCount(2);
});

test("a saved markup opens full screen, is fixed, and is deleted only after a confirmation", async () => {
  await goTask(planTask);
  await markups().first().getByTestId("task-photo").click();
  await expect(app.page.getByTestId("markup-viewer")).toBeVisible();
  const sz = await imageSize(app.page.getByTestId("markup-viewer-image"));
  console.log("saved markup px", sz);
  expect(Math.max(sz.w, sz.h)).toBeGreaterThanOrEqual(1400);
  await expect(app.page.getByTestId("mk-editor")).toHaveCount(0); // viewing never opens the editor
  await shotDoc("07-markup-fullscreen");
  await app.page.getByTestId("markup-delete").click();
  await expect(app.page.getByTestId("markup-delete-dialog")).toBeVisible();
  await app.page.getByTestId("confirm-cancel").click();
  await expect(app.page.getByTestId("markup-viewer")).toBeVisible();
  await expect(markups()).toHaveCount(2);
  await app.page.getByTestId("markup-delete").click();
  await app.page.getByTestId("confirm-ok").click();
  await expect(app.page.getByTestId("markup-viewer")).toHaveCount(0);
  await expect(markups()).toHaveCount(1, { timeout: 30_000 });
  await expect(app.page.getByTestId("timeline-markup").filter({ hasText: "Removed a markup" })).toHaveCount(1);
  await shotDoc("08-after-delete");
});

test("a task with a plan pin and a 3D location asks which view first", async () => {
  await goTask(dualTask);
  await app.page.getByTestId("task-markup-create").click();
  await expect(app.page.getByTestId("mk-choose")).toBeVisible();
  await expect(app.page.getByTestId("mk-choose-plan")).toBeVisible();
  await expect(app.page.getByTestId("mk-choose-3d")).toBeVisible();
  await shotDoc("09-choose-view");
  await app.page.getByTestId("mk-choose-plan").click();
  await expect(app.page.getByTestId("mk-editor")).toBeVisible({ timeout: 90_000 });
  await app.page.getByTestId("mk-cancel").click(); // nothing drawn: no question
  await expect(app.page.getByTestId("task-detail")).toBeVisible();
  await expect(markups()).toHaveCount(0);
});

test("3D markup: the viewer takes one HD frame at the task's view and is gone before the editor opens", async () => {
  await openEditor(bimTask, undefined);
  const sz = await imageSize(app.page.getByTestId("mk-image"));
  console.log("3d capture px", sz);
  expect(Math.max(sz.w, sz.h)).toBeGreaterThanOrEqual(1400);
  expect(Math.min(sz.w, sz.h)).toBeGreaterThanOrEqual(900); // the whole screen, not a collapsed strip
  await expect(app.page.getByTestId("model-page")).toHaveCount(0);
  await expect(app.page.getByTestId("mk-capture3d")).toHaveCount(0);
  const reg = await registry();
  console.log("viewer registry", reg);
  expect(reg).toMatchObject({ live: 0, overlaps: 0 });
  expect(reg!.peak).toBeLessThanOrEqual(1);
  await shotDoc("10-3d-capture");
  await pickTool("arrow");
  await stroke([0.7, 0.2], [0.5, 0.45]);
  await pickTool("cloud");
  await stroke([0.3, 0.4], [0.55, 0.65]);
  await expect.poll(inkCount).toBe(2);
  await app.page.getByTestId("mk-accept").click();
  await expect(app.page.getByTestId("task-detail")).toBeVisible({ timeout: 60_000 });
  await expect(markups()).toHaveCount(1, { timeout: 30_000 });
  await shotDoc("11-3d-markup-saved");
  expect(await registry()).toMatchObject({ live: 0 });
});

test("both orientations: the editor lays out tools and picture in landscape and portrait", async () => {
  await landscape();
  await openEditor(planTask);
  await shotDoc("12-editor-landscape");
  const tools = await app.page.getByTestId("mk-tools").boundingBox();
  const st = await stage();
  expect(tools!.x + tools!.width).toBeLessThanOrEqual(st.x + 2); // tools on the left edge
  for (const t of ["pen", "highlight", "arrow", "rect", "ellipse", "cloud", "text"]) {
    const b = (await app.page.getByTestId(`mk-tool-${t}`).boundingBox())!;
    expect(b.height, `${t} height`).toBeGreaterThanOrEqual(44);
    expect(b.width, `${t} width`).toBeGreaterThanOrEqual(44);
  }
  for (const id of ["mk-undo", "mk-redo", "mk-accept", "mk-cancel"]) {
    const b = (await app.page.getByTestId(id).boundingBox())!;
    expect(b.height, id).toBeGreaterThanOrEqual(44);
  }
  await pickTool("pen");
  await stroke([0.3, 0.3], [0.6, 0.5]);
  await expect.poll(inkCount).toBe(1);
  await portrait(); // rotating keeps the drawing
  await expect(app.page.getByTestId("mk-editor")).toBeVisible();
  expect(await inkCount()).toBe(1);
  const tp = (await app.page.getByTestId("mk-tools").boundingBox())!;
  const sp = await stage();
  expect(tp.y).toBeGreaterThanOrEqual(sp.y + sp.height - 2); // tools along the bottom
  await shotDoc("13-editor-portrait");
  await app.page.getByTestId("mk-cancel").click();
  await app.page.getByTestId("confirm-ok").click();
  await expect(app.page.getByTestId("task-detail")).toBeVisible();
});

test("offline: a markup is saved to the outbox, then syncs when the connection returns", async () => {
  await app.shell("cmd connectivity airplane-mode enable");
  await expect(app.page.getByTestId("sync-chip")).toHaveAttribute("data-state", "offline", { timeout: 30_000 });
  await openEditor(planTask);
  await pickTool("rect");
  await stroke([0.3, 0.3], [0.7, 0.6]);
  await app.page.getByTestId("mk-accept").click();
  await expect(app.page.getByTestId("task-detail")).toBeVisible({ timeout: 60_000 });
  await expect(markups()).toHaveCount(2, { timeout: 30_000 });
  await shotDoc("14-offline-markup");
  await app.shell("cmd connectivity airplane-mode disable");
  await expect(app.page.getByTestId("sync-chip")).toHaveAttribute("data-state", "online", { timeout: 60_000 });
  await expect(app.page.getByTestId("task-detail").getByTestId("sync-badge")).toHaveCount(0, { timeout: 90_000 });
  await expect(markups()).toHaveCount(2);
  await expect(app.page.locator('[data-testid="task-markup"][data-pending="1"]')).toHaveCount(0, { timeout: 60_000 });
});
