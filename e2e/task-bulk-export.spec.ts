import { expect, test, type Locator } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { launchApp, PKG, waitForTestHooks, type AppSession } from "./app";
import { setRotation } from "./qa";

/**
 * Task bulk actions and export on the tablet (agent/task-bulk-export): select mode, bulk status / assignee / priority offline then
 * sync, the skipped-items summary, PDF report, CSV and BCF files (read back from the app cache), the share sheet, Save to Downloads,
 * cancel, a 500+ task export, both orientations. Screenshots (device framebuffer) go to docs/spikes/task-bulk-export/.
 */
declare global {
  interface Window {
    __ffmExportLog?: { name: string; size: number; via: "share" | "downloads" | "download"; uri: string | null; at: number }[];
  }
}

test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);

const SHOTS = join(process.cwd(), "docs", "spikes", "task-bulk-export");
mkdirSync(SHOTS, { recursive: true });

let app: AppSession;
const PHOTO_TITLE = "Report photo task";

async function shot(name: string) {
  await app.device.screenshot({ path: join(SHOTS, `${name}.png`) }).catch(() => undefined);
}

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

const rows = () => app.page.getByTestId("task-row");
const rowById = (id: string) => app.page.locator(`[data-testid="task-row"][data-task-id="${id}"]`);

async function idsWithStatus(status: number, n: number): Promise<string[]> {
  const ids = await rows().evaluateAll((els, s) => els.filter((e) => e.getAttribute("data-status") === String(s)).map((e) => e.getAttribute("data-task-id")!), status);
  expect(ids.length, `rows with status ${status}`).toBeGreaterThanOrEqual(n);
  return ids.slice(0, n);
}

/** Rows a field edit can change: not closed, nothing queued. */
async function idsEditable(n: number): Promise<string[]> {
  const ids = await rows().evaluateAll((els) => els.filter((e) => !["65", "80"].includes(e.getAttribute("data-status") ?? "") && !e.querySelector('[data-testid="sync-badge"]')).map((e) => e.getAttribute("data-task-id")!));
  expect(ids.length, "editable rows").toBeGreaterThanOrEqual(n);
  return ids.slice(0, n);
}

/** The app can be recreated while a system sheet is on top: attach to the current WebView and go back to the list. */
async function backToList() {
  for (let i = 0; i < 8; i++) {
    try {
      await app.page.evaluate(() => 1);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 3000));
      try {
        const webView = await app.device.webView({ pkg: PKG }, { timeout: 30_000 });
        app.page = await webView.page();
      } catch {
        /* retry */
      }
    }
  }
  await app.page.evaluate(() => {
    location.hash = "#/tasks";
  });
  await expect(app.page.getByTestId("tasks-list-pane")).toBeVisible();
  // the page survived the system sheet: close the dialog and select mode it left open
  if (await app.page.getByTestId("export-sheet").isVisible().catch(() => false)) await app.page.getByTestId("sheet-close").click();
  await leaveSelectMode();
  await app.page.getByTestId("chip-all").click();
}

async function leaveSelectMode() {
  if (await app.page.getByTestId("select-done").isVisible().catch(() => false)) await app.page.getByTestId("select-done").click();
}

/** Select exactly these rows (enters select mode on the first). */
async function selectOnly(ids: string[]) {
  await leaveSelectMode();
  await app.page.getByTestId("select-mode").click();
  for (const id of ids) {
    await rowById(id).scrollIntoViewIfNeeded();
    await rowById(id).click();
  }
  await expect(app.page.getByTestId("bulk-count")).toHaveAttribute("data-count", String(ids.length));
}

async function longPress(target: Locator, ms = 800) {
  const b = (await target.boundingBox())!;
  await app.page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await app.page.mouse.down();
  await app.page.waitForTimeout(ms);
  await app.page.mouse.up();
}

/** A file from the app cache, read through run-as (debug build). */
async function cacheFile(name: string): Promise<Buffer> {
  const b64 = (await app.shell(`run-as ${PKG} sh -c 'base64 -w0 cache/exports/${name}'`)).trim();
  return Buffer.from(b64, "base64");
}

/** Minimal zip reader: entries by name from the central directory, inflated. */
function readZip(buf: Buffer): Map<string, Buffer> {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(eocd).toBeGreaterThan(0);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString("utf8");
    const lnlen = buf.readUInt16LE(lho + 26);
    const lelen = buf.readUInt16LE(lho + 28);
    const data = buf.subarray(lho + 30 + lnlen + lelen, lho + 30 + lnlen + lelen + csize);
    if (!name.endsWith("/")) out.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data));
    p += 46 + nlen + elen + clen;
  }
  return out;
}

async function runExport(format: "pdf" | "csv" | "bcf21" | "bcf30", opts: { photos?: number } = {}) {
  await app.page.getByTestId(`export-format-${format}`).click();
  if (format === "pdf" && opts.photos !== undefined) await app.page.getByTestId(`export-photos-${opts.photos}`).click();
  await app.page.getByTestId("export-start").click();
  const result = app.page.getByTestId("export-result");
  await expect(result).toBeVisible({ timeout: 240_000 });
  const name = (await result.getAttribute("data-file"))!;
  return { name, size: Number(await result.getAttribute("data-size")), count: Number(await result.getAttribute("data-count")), pages: Number((await result.getAttribute("data-pages")) || 0) };
}

async function closeExport() {
  await app.page.getByTestId("sheet-close").click();
  await expect(app.page.getByTestId("export-sheet")).toHaveCount(0);
}

test.beforeAll(async () => {
  app = await launchApp();
});
test.afterAll(async () => {
  await app?.shell("cmd connectivity airplane-mode disable").catch(() => undefined);
  if (app) await setRotation(app, 0).catch(() => undefined);
  await app?.shell("rm -f /sdcard/Download/freefield-*").catch(() => undefined);
  await app?.close();
});

test("sign in; a task with photos and comments for the report", async () => {
  await signIn();
  await openTasks();
  await expect(rows().first()).toBeVisible({ timeout: 30_000 });
  await waitForTestHooks(app.page);
  await app.page.evaluate(async (t) => {
    const id = await window.__ffmTest!.createTaskWithPhotos(t, 2, 200);
    return id;
  }, PHOTO_TITLE);
  await expect(app.page.getByText(PHOTO_TITLE).first()).toBeVisible({ timeout: 30_000 });
});

test("long-press enters select mode; tap toggles; select all visible and clear (portrait)", async () => {
  await setRotation(app, 0);
  await app.page.getByTestId("chip-all").click();
  const first = rows().first();
  const id = (await first.getAttribute("data-task-id"))!;
  await longPress(first);
  await expect(app.page.getByTestId("select-toolbar")).toBeVisible();
  await expect(app.page.getByTestId("bulk-count")).toHaveAttribute("data-count", "1");
  await expect(rowById(id)).toHaveAttribute("data-checked", "1");
  // the long press must not have opened the task
  await expect(app.page.getByTestId("task-detail")).toHaveCount(await app.page.getByTestId("tasks-split").count());
  await rows().nth(1).click();
  await expect(app.page.getByTestId("bulk-count")).toHaveAttribute("data-count", "2");
  await shot("bulk-10-select-portrait");
  for (const t of ["bulk-status", "bulk-assignee", "bulk-export"]) {
    const box = (await app.page.getByTestId(t).boundingBox())!;
    expect(box.height, t).toBeGreaterThanOrEqual(43.5);
  }
  const total = await rows().count();
  await app.page.getByTestId("select-all").click();
  await expect(app.page.getByTestId("bulk-count")).toHaveAttribute("data-count", String(total));
  await app.page.getByTestId("select-clear").click();
  await expect(app.page.getByTestId("bulk-bar")).toHaveCount(0);
  await app.page.getByTestId("select-done").click();
  await expect(app.page.getByTestId("select-toolbar")).toHaveCount(0);
});

test("bulk status over a mixed selection while offline: updated + skipped summary, queued, then everything syncs", async () => {
  await app.shell("cmd connectivity airplane-mode enable");
  await expect(app.page.getByTestId("sync-chip")).toHaveAttribute("data-state", "offline", { timeout: 30_000 });
  const ongoing = await idsWithStatus(20, 2);
  const awaiting = await idsWithStatus(40, 1);
  const closed = [...(await app.page.locator('[data-testid="task-row"][data-status="65"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-task-id")!))), ...(await app.page.locator('[data-testid="task-row"][data-status="80"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-task-id")!)))].slice(0, 1);
  expect(closed.length).toBe(1);
  await selectOnly([...ongoing, ...awaiting, ...closed]);
  await app.page.getByTestId("bulk-status").click();
  await expect(app.page.getByTestId("bulk-status-sheet")).toBeVisible();
  await shot("bulk-20-status-sheet");
  await expect(app.page.getByTestId("bulk-status-complete")).toContainText("2 of 4");
  await app.page.getByTestId("bulk-status-complete").click();
  const res = app.page.getByTestId("bulk-result");
  await expect(res).toBeVisible();
  await expect(res).toHaveAttribute("data-updated", "2");
  await expect(res).toHaveAttribute("data-skipped", "2");
  await expect(app.page.getByTestId("bulk-result-text")).toHaveText("2 updated, 2 skipped: 1 not allowed in this status, 1 task is closed");
  await shot("bulk-21-summary-offline");
  // same actions a single edit queues: the rows show the new status and are queued
  for (const id of ongoing) {
    await expect(rowById(id)).toHaveAttribute("data-status", "40");
    await expect(rowById(id).getByTestId("sync-badge")).toHaveAttribute("data-state", /pending/);
  }
  await expect(rowById(closed[0]!)).toHaveAttribute("data-status", /65|80/);
  await app.shell("cmd connectivity airplane-mode disable");
  await expect(app.page.getByTestId("sync-chip")).toHaveAttribute("data-state", "online", { timeout: 60_000 });
  for (const id of ongoing) await expect(rowById(id).getByTestId("sync-badge")).toHaveCount(0, { timeout: 90_000 });
  for (const id of ongoing) await expect(rowById(id)).toHaveAttribute("data-status", "40");
});

test("bulk undo, assignee and priority", async () => {
  const ids = await idsEditable(2);
  await selectOnly(ids);
  await app.page.getByTestId("bulk-assignee").click();
  const members = app.page.locator('[data-testid^="bulk-assignee-"]:not([data-testid="bulk-assignee-none"]):not([data-testid="bulk-assignee-sheet"])');
  // a member none of the rows has yet, so both rows change
  const current = await Promise.all(ids.map((id) => rowById(id).locator(".avatar").getAttribute("title")));
  let member = members.first();
  let name = (await member.locator(".avatar").getAttribute("title"))!;
  for (let i = 0; i < (await members.count()); i++) {
    const n = (await members.nth(i).locator(".avatar").getAttribute("title"))!;
    if (!current.includes(n)) {
      member = members.nth(i);
      name = n;
      break;
    }
  }
  await member.click();
  await expect(app.page.getByTestId("bulk-result-text")).toHaveText(/^2 updated/);
  for (const id of ids) await expect(rowById(id).locator(".avatar")).toHaveAttribute("title", name);
  await app.page.getByTestId("bulk-undo").click();
  await expect(app.page.getByTestId("bulk-result-text")).toContainText("Reverted 2 changes");
  for (const [i, id] of ids.entries()) await expect(rowById(id).locator(".avatar")).toHaveAttribute("title", current[i]!, { timeout: 20_000 });
  for (const id of ids) await expect(rowById(id).getByTestId("sync-badge")).toHaveCount(0, { timeout: 60_000 });
  // a row that is still syncing is skipped, so wait for the queue to drain between the changes
  const settled = async () => {
    for (const id of ids) await expect(rowById(id).getByTestId("sync-badge")).toHaveCount(0, { timeout: 60_000 });
  };
  await settled();
  await app.page.getByTestId("bulk-priority").click();
  await app.page.getByTestId("bulk-priority-critical").click();
  await expect(app.page.getByTestId("bulk-result-text")).toHaveText(/^2 updated/);
  await settled();
  // applying the same priority again changes nothing: both rows are reported as skipped
  await app.page.getByTestId("bulk-priority").click();
  await app.page.getByTestId("bulk-priority-critical").click();
  await expect(app.page.getByTestId("bulk-result-text")).toHaveText("0 updated, 2 skipped: already set");
  await app.page.getByTestId("select-done").click();
});

test("export a selection as a PDF report: pages, task titles, photos, share sheet and Downloads", async () => {
  const photoRow = rows().filter({ hasText: PHOTO_TITLE }).first();
  const photoId = (await photoRow.getAttribute("data-task-id"))!;
  const others = (await rows().evaluateAll((els) => els.map((e) => e.getAttribute("data-task-id")!))).filter((x) => x !== photoId).slice(0, 2);
  await selectOnly([photoId, ...others]);
  const titles = await Promise.all([photoId, ...others].map((id) => rowById(id).locator(".task-title").innerText()));
  await app.page.getByTestId("bulk-export").click();
  await expect(app.page.getByTestId("export-sheet")).toBeVisible();
  await expect(app.page.getByTestId("export-scope")).toContainText("Selected tasks: 3 tasks");
  await shot("bulk-30-export-sheet");
  const r = await runExport("pdf", { photos: 4 });
  expect(r.pages).toBeGreaterThan(0);
  await expect(app.page.getByTestId("export-file")).toContainText(r.name);
  await shot("bulk-31-export-done");
  const pdf = await cacheFile(r.name);
  expect(pdf.length).toBe(r.size);
  const text = pdf.toString("latin1");
  expect(text.startsWith("%PDF-1.4")).toBe(true);
  expect((text.match(/\/Type \/Page /g) ?? []).length).toBe(r.pages);
  // long titles wrap: the start of each title is on one line
  for (const t of titles) expect(text, t).toContain(t.slice(0, 18).replace(/[()\\]/g, (c) => `\\${c}`));
  expect(text).toContain("Task report");
  expect((text.match(/\/Subtype \/Image/g) ?? []).length, "the two photos of the photo task are embedded").toBeGreaterThanOrEqual(2);

  // save a copy to Downloads
  await app.page.getByTestId("export-save").click();
  await expect(app.page.getByTestId("export-saved")).toContainText(`Downloads/${r.name}`);
  expect((await app.shell(`ls -l /sdcard/Download/${r.name}`)).trim()).toContain(r.name);
  await shot("bulk-33-saved-downloads");

  // share sheet: the file is handed to the system chooser
  await app.page.getByTestId("export-share").click();
  await expect.poll(() => app.page.evaluate(() => window.__ffmExportLog?.filter((e) => e.via === "share").length ?? 0)).toBe(1);
  const entry = await app.page.evaluate(() => window.__ffmExportLog!.at(-1)!);
  expect(entry.name).toBe(r.name);
  expect(entry.uri).toContain(`exports/${r.name}`);
  await app.page.waitForTimeout(2500);
  const top = await app.shell("dumpsys activity activities | grep -m3 -E 'topResumedActivity|mResumedActivity'");
  console.log(`share sheet top activity: ${top.trim().split("\n")[0]}`);
  expect(top, "the system chooser is on top").toMatch(/Chooser|Resolver|sharesheet/i);
  await shot("bulk-32-share-sheet");
  await app.shell("input keyevent 4"); // dismiss the chooser
  await backToList();
});

test("CSV of the current view and BCF 2.1 / 3.0 of a selection", async () => {
  await backToList();
  const total = await rows().count();
  await app.page.getByTestId("export-view").click();
  await expect(app.page.getByTestId("export-scope")).toContainText(`Current view: ${total} tasks`);
  const csv = await runExport("csv");
  expect(csv.count).toBe(total);
  const text = (await cacheFile(csv.name)).toString("utf8");
  const lines = text.replace(/^﻿/, "").trimEnd().split("\r\n");
  expect(lines[0]).toContain("Number,Title,Description,Type,Status");
  expect(lines.length).toBe(total + 1);
  expect(text).toContain(PHOTO_TITLE);
  await closeExport();

  const ids = (await rows().evaluateAll((els) => els.map((e) => e.getAttribute("data-task-id")!))).slice(0, 3);
  const titles = await Promise.all(ids.map((id) => rowById(id).locator(".task-title").innerText()));
  await selectOnly(ids);
  await app.page.getByTestId("bulk-export").click();
  for (const [fmt, ext] of [["bcf21", /bcf21\.bcfzip$/], ["bcf30", /bcf30\.bcf$/]] as const) {
    const b = await runExport(fmt);
    expect(b.name).toMatch(ext);
    expect(b.count).toBe(3);
    const zip = readZip(await cacheFile(b.name));
    const markups = [...zip.keys()].filter((k) => k.endsWith("/markup.bcf"));
    expect(markups.length, `${fmt} topics`).toBe(3);
    const all = markups.map((k) => zip.get(k)!.toString("utf8")).join("\n");
    for (const t of titles) expect(all, `${fmt} has topic "${t}"`).toContain(t.replace(/&/g, "&amp;"));
    expect(zip.has("bcf.version")).toBe(true);
    // back to the format picker for the next run
    await app.page.getByTestId("sheet-close").click();
    await app.page.getByTestId("bulk-export").click();
  }
  await closeExport();
  await app.page.getByTestId("select-done").click();
});

test("task detail: export this task as a PDF", async () => {
  await rows().filter({ hasText: PHOTO_TITLE }).first().click();
  await expect(app.page.getByTestId("task-detail")).toBeVisible();
  await app.page.getByTestId("task-export").click();
  await expect(app.page.getByTestId("export-scope")).toContainText("This task: 1 task");
  await expect(app.page.getByTestId("export-format-pdf")).toBeVisible();
  const r = await runExport("pdf", { photos: 4 });
  expect(r.pages).toBeGreaterThanOrEqual(2); // title page + the task
  const text = (await cacheFile(r.name)).toString("latin1");
  expect(text).toContain(PHOTO_TITLE);
  await shot("bulk-40-detail-export");
  await closeExport();
});

test("both orientations: select mode, bulk bar and export sheet", async () => {
  await setRotation(app, 1);
  await expect.poll(() => app.page.evaluate(() => window.innerWidth)).toBeGreaterThanOrEqual(840);
  await expect(app.page.getByTestId("tasks-list-pane")).toBeVisible();
  const ids = (await rows().evaluateAll((els) => els.map((e) => e.getAttribute("data-task-id")!))).slice(0, 3);
  await selectOnly(ids);
  await expect(app.page.getByTestId("bulk-bar")).toBeVisible();
  await shot("bulk-50-select-landscape");
  await app.page.getByTestId("bulk-status").click();
  await shot("bulk-51-status-sheet-landscape");
  await app.page.getByTestId("sheet-close").click();
  await app.page.getByTestId("bulk-export").click();
  await expect(app.page.getByTestId("export-sheet")).toBeVisible();
  await app.page.waitForTimeout(800);
  await shot("bulk-52-export-landscape");
  await closeExport();
  await app.page.getByTestId("select-done").click();
  await setRotation(app, 0);
  await expect.poll(() => app.page.evaluate(() => window.innerWidth < window.innerHeight)).toBe(true);
});

test("a 500+ task PDF report is built in chunks with progress, within memory limits; cancel stops it", async () => {
  const N = 520;
  // the previous tests left the portrait detail screen open: back to the list
  await app.page.evaluate(() => {
    location.hash = "#/tasks";
  });
  await expect(app.page.getByTestId("tasks-list-pane")).toBeVisible();
  await app.page.evaluate(async (n) => {
    for (let i = 0; i < n; i++) await window.__ffmTest!.createTask(`Bulk fixture ${String(i).padStart(3, "0")}`);
  }, N);
  await app.page.getByTestId("chip-all").click();
  await expect(app.page.getByTestId("tasks-list-pane")).toBeVisible();
  // the list loads the newest 200 tasks at a time: load every page so the view holds all of them
  for (let i = 0; i < 12; i++) {
    const more = app.page.getByTestId("load-more");
    if (!(await more.isVisible().catch(() => false))) break;
    await more.click();
    await app.page.waitForTimeout(1500);
  }
  // cancel first: start, then Cancel while it runs
  await app.page.getByTestId("export-view").click();
  await app.page.getByTestId("export-format-pdf").click();
  await app.page.getByTestId("export-photos-0").click();
  await app.page.evaluate(() => {
    const w = window as unknown as { __peakHeap: number; __heapTimer?: number };
    w.__peakHeap = 0;
    w.__heapTimer = window.setInterval(() => {
      const m = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
      if (m) w.__peakHeap = Math.max(w.__peakHeap, m.usedJSHeapSize);
    }, 200);
  });
  await app.page.getByTestId("export-start").click();
  const progress = app.page.getByTestId("export-progress");
  await expect(progress).toBeVisible();
  await expect(progress).toHaveAttribute("data-phase", "build", { timeout: 60_000 });
  await app.page.getByTestId("export-cancel").click();
  await expect(app.page.getByTestId("export-cancelled")).toBeVisible({ timeout: 30_000 });
  const leftovers = (await app.shell(`run-as ${PKG} ls cache/exports`)).split("\n").filter((f) => f.startsWith("freefield-task-report"));
  const before = leftovers.length;
  // now the full export
  const t0 = Date.now();
  await app.page.getByTestId("export-start").click();
  await expect(app.page.getByTestId("export-result")).toBeVisible({ timeout: 280_000 });
  const secs = Math.round((Date.now() - t0) / 1000);
  const res = app.page.getByTestId("export-result");
  const pages = Number(await res.getAttribute("data-pages"));
  const count = Number(await res.getAttribute("data-count"));
  const size = Number(await res.getAttribute("data-size"));
  const peak = await app.page.evaluate(() => { const w = window as unknown as { __peakHeap: number; __heapTimer: number }; window.clearInterval(w.__heapTimer); return Math.round(w.__peakHeap / 1048576); });
  console.log(`500+ report: ${count} tasks, ${pages} pages, ${(size / 1048576).toFixed(1)} MB, ${secs}s, peak JS heap ${peak} MB`);
  expect(count).toBeGreaterThanOrEqual(N);
  expect(pages).toBeGreaterThan(100);
  expect(peak, "JS heap stays far below the 3.5 GB device").toBeLessThan(400);
  const after = (await app.shell(`run-as ${PKG} ls cache/exports`)).split("\n").filter((f) => f.startsWith("freefield-task-report"));
  expect(after.length, "the cancelled export left no partial file").toBe(before + 1);
  const file = (await res.getAttribute("data-file"))!;
  const head = (await app.shell(`run-as ${PKG} sh -c 'head -c 8 cache/exports/${file}'`)).trim();
  expect(head).toBe("%PDF-1.4");
  await shot("bulk-60-large-export");
  await closeExport();
});

test("a photo-heavy report (160 photos on 40 tasks inside a 570-task view) stays within memory limits and keeps the photos", async () => {
  const PHOTO_TASKS = 40;
  const PER_TASK = 4;
  await app.page.evaluate(
    async ([n, per]) => {
      for (let i = 0; i < (n as number); i++) await window.__ffmTest!.createTaskWithPhotos(`Photo fixture ${String(i).padStart(2, "0")}`, per as number, 300);
    },
    [PHOTO_TASKS, PER_TASK],
  );
  await app.page.getByTestId("chip-all").click();
  for (let i = 0; i < 12; i++) {
    const more = app.page.getByTestId("load-more");
    if (!(await more.isVisible().catch(() => false))) break;
    await more.click();
    await app.page.waitForTimeout(1500);
  }
  await app.page.getByTestId("export-view").click();
  await app.page.getByTestId("export-format-pdf").click();
  await app.page.getByTestId("export-photos-4").click();
  await app.page.evaluate(() => {
    const w = window as unknown as { __peakHeap: number; __heapTimer?: number };
    w.__peakHeap = 0;
    w.__heapTimer = window.setInterval(() => {
      const m = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
      if (m) w.__peakHeap = Math.max(w.__peakHeap, m.usedJSHeapSize);
    }, 200);
  });
  const t0 = Date.now();
  await app.page.getByTestId("export-start").click();
  await expect(app.page.getByTestId("export-result")).toBeVisible({ timeout: 280_000 });
  const secs = Math.round((Date.now() - t0) / 1000);
  const res = app.page.getByTestId("export-result");
  const file = (await res.getAttribute("data-file"))!;
  const size = Number(await res.getAttribute("data-size"));
  const pages = Number(await res.getAttribute("data-pages"));
  const peak = await app.page.evaluate(() => { const w = window as unknown as { __peakHeap: number; __heapTimer: number }; window.clearInterval(w.__heapTimer); return Math.round(w.__peakHeap / 1048576); });
  const images = Number((await app.shell(`run-as ${PKG} sh -c "grep -a -c '/Subtype /Image' cache/exports/${file}"`)).trim());
  console.log(`photo report: ${pages} pages, ${(size / 1048576).toFixed(1)} MB, ${secs}s, peak JS heap ${peak} MB, ${images} image objects`);
  expect(peak).toBeLessThan(400);
  expect(images, "every photo of the photo tasks is embedded").toBeGreaterThanOrEqual(PHOTO_TASKS * PER_TASK);
  expect(size).toBeLessThan(90 * 1024 * 1024 + 5 * 1024 * 1024);
  await shot("bulk-61-photo-report");
  await closeExport();
});
