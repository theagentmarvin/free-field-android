import { expect, test, type Locator } from "@playwright/test";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { launchApp, SHOTS, touchSession, type AppSession } from "./app";
import { center, dbg, deviceShot, gotoModel, waitReady } from "./model";
import { geometryStats } from "./png";
import { setRotation } from "./qa";

/**
 * Link view (docs/spikes/linkview.md): the calibrated plan beside the 3D view, a camera marker on the plan, first person at eye height in 3D.
 * The demo project has one calibrated plan, "S-101 - First Floor.pdf" on "101 FIRST FLOOR" (elevation 0); the spec adds a second calibration
 * (S-102 on "201 SECOND FLOOR") straight into the device database to exercise storey changes.
 */
test.describe.configure({ mode: "serial", timeout: 240_000 });

let app: AppSession;
let touch: Awaited<ReturnType<typeof touchSession>>;

const DOCS = join(process.cwd(), "docs", "spikes", "linkview");
const S102 = "aee94b63-3db1-4cb8-9e6a-3e5d521e7f38";
const S101 = "920118c4-cdb7-4148-a530-b71fe83ca142";

type Params = { scale: number; rotation: number; translateX: number; translateZ: number };
interface LvState {
  storey: string;
  plan: string | null;
  params: Params | null;
  page: { width: number; height: number } | null;
  walker: { x: number; z: number; floorY: number; yaw: number };
  dir: "row" | "column";
  planShare: number;
  swapped: boolean;
  outside: boolean;
  floorY: number;
}
const lv = (): Promise<LvState> => app.page.evaluate(() => (window as unknown as { __ffmLinkview: { state(): unknown } }).__ffmLinkview.state() as never);

// The calibration formula written out here on purpose: world = scale * R(rotation) * page + t (page y down).
const toWorld = (p: Params, pt: { x: number; y: number }) => {
  const c = Math.cos(p.rotation);
  const s = Math.sin(p.rotation);
  return { x: p.scale * (c * pt.x - s * pt.y) + p.translateX, z: p.scale * (s * pt.x + c * pt.y) + p.translateZ };
};
const toPage = (p: Params, w: { x: number; z: number }) => {
  const c = Math.cos(p.rotation);
  const s = Math.sin(p.rotation);
  const dx = w.x - p.translateX;
  const dz = w.z - p.translateZ;
  return { x: (c * dx + s * dz) / p.scale, y: (-s * dx + c * dz) / p.scale };
};
const deg = (r: number) => (r * 180) / Math.PI;
const angDiff = (a: number, b: number) => Math.abs(deg(Math.atan2(Math.sin(a - b), Math.cos(a - b))));

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
    console.log("LINKVIEW STATE:", JSON.stringify(await lv().catch(() => null)));
    console.log("MODEL STATE:", JSON.stringify(await dbg(app.page, (d) => d.state()).catch(() => null)));
    await app.shot(`linkview-fail-${info.title.replace(/\W+/g, "-").slice(0, 40)}`).catch(() => undefined);
  }
});
test.afterAll(async () => {
  await setRotation(app, 0).catch(() => undefined);
  await app?.shell("cmd connectivity airplane-mode disable").catch(() => undefined);
  await touch?.detach().catch(() => undefined);
  await app?.close();
});

/** Screenshot into test-results and into docs/spikes/linkview/ (the device framebuffer: the page capture misses WebGL pixels). */
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
const goTab = (name: string) => app.page.getByTestId("tabs").getByRole("link", { name, exact: true }).click();
/** Building of a plan file, read from the device database. */
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
const planRow = (name: string) => app.page.getByTestId("plan-row").filter({ hasText: name });
const box = async (l: Locator) => (await l.boundingBox())!;

async function openPlan(name: string) {
  await goTab("Plans");
  await planRow(name).getByTestId("plan-open").click();
  const viewer = app.page.getByTestId("plan-viewer");
  await expect(viewer).toBeVisible({ timeout: 60_000 });
  await expect.poll(async () => Number(await viewer.getAttribute("data-drawn")), { timeout: 30_000 }).toBeGreaterThan(0);
}

/** The Link view is up: both panes, the 3D view ready and walking, the marker drawn. */
async function linkviewReady() {
  await expect(app.page.getByTestId("lv-page")).toBeVisible({ timeout: 30_000 });
  await waitReady(app.page);
  await expect(app.page.getByTestId("model-page")).toHaveAttribute("data-mode", "walk", { timeout: 30_000 });
  await expect(app.page.getByTestId("lv-marker")).toBeVisible({ timeout: 60_000 });
  await app.page.waitForTimeout(800);
}

const pose = async () => (await dbg(app.page, (d) => d.pose()))!;
const eye = (p: { pos: number[]; target: number[] }) => ({ x: p.pos[0], z: p.pos[2], bearing: Math.atan2(p.target[2] - p.pos[2], p.target[0] - p.pos[0]) });

/** Real pixels in the 3D pane (not the toolbar strip): geometry on the device framebuffer. */
async function paneGeometry(name: string) {
  for (let i = 0; i < 8; i++) {
    const img = await deviceShot(app, name);
    const k = img.width / (await app.page.evaluate(() => window.innerWidth));
    const b = await box(app.page.getByTestId("lv-model-pane"));
    const g = geometryStats(img, { x: (b.x + b.width * 0.2) * k, y: (b.y + b.height * 0.2) * k, w: b.width * 0.6 * k, h: b.height * 0.6 * k });
    console.log(`pane geometry ${name}: ${(g.fraction * 100).toFixed(1)} %, ${g.colours} colours`);
    if (g.fraction > 0.01 && g.colours > 3) return g;
    await app.page.waitForTimeout(2500);
  }
  throw new Error(`no 3D geometry in the pane (${name})`);
}

/** A page point of the plan that is clear of the marker's dot and handle, plus where it is on screen. */
async function planTarget(dx: number, dy: number) {
  const st = await lv();
  const viewer = await box(app.page.getByTestId("plan-viewer"));
  const m = app.page.getByTestId("lv-marker");
  const zoom = Number(await app.page.getByTestId("plan-viewer").getAttribute("data-zoom"));
  const mx = Number(await m.getAttribute("data-screen-x"));
  const my = Number(await m.getAttribute("data-screen-y"));
  const px = Number(await m.getAttribute("data-page-x"));
  const py = Number(await m.getAttribute("data-page-y"));
  const sx = mx + dx;
  const sy = my + dy;
  return { st, screen: { x: viewer.x + sx, y: viewer.y + sy }, page: { x: px + dx / zoom, y: py + dy / zoom }, zoom };
}

/** A tappable spot of the plan: on the page, on the plan pane, clear of the marker's dot, wedge and handle. */
async function freePlanTarget() {
  for (const [dx, dy] of [[-110, 90], [110, 90], [-110, -90], [110, -90], [0, 140], [0, -140], [140, 0]]) {
    const t = await planTarget(dx, dy);
    const pg = t.st.page!;
    if (t.page.x > 5 && t.page.y > 5 && t.page.x < pg.width - 5 && t.page.y < pg.height - 5) {
      const vb = await box(app.page.getByTestId("plan-viewer"));
      if (t.screen.x > vb.x + 30 && t.screen.x < vb.x + vb.width - 70 && t.screen.y > vb.y + 30 && t.screen.y < vb.y + vb.height - 30) return t;
    }
  }
  throw new Error("no free spot on the plan");
}

test("entry from the plan viewer: a calibrated plan opens the Link view; an uncalibrated one explains instead", async () => {
  await landscape();
  await openPlan("S-101");
  const link = app.page.getByTestId("plan-linkview");
  await expect(link).toHaveAttribute("data-linkable", "1");
  expect((await box(link)).height).toBeGreaterThanOrEqual(44);
  await shotDoc("01-plan-viewer-entry");
  await link.click();
  await linkviewReady();
  const st = await lv();
  expect(st.plan).toBe(S101);
  expect(st.storey).toBe("101 FIRST FLOOR");
  expect(st.params).not.toBeNull();
  await shotDoc("02-linkview-landscape");

  // the uncalibrated plan: the button says why, nothing opens
  await goTab("Plans");
  await planRow("S-102").getByTestId("plan-open").click();
  await expect(app.page.getByTestId("plan-page")).toBeVisible({ timeout: 30_000 });
  const l2 = app.page.getByTestId("plan-linkview");
  await expect(l2).toHaveAttribute("data-linkable", "0");
  await l2.click();
  await expect(app.page.getByTestId("lv-uncalibrated")).toBeVisible();
  await expect(app.page.getByTestId("lv-uncalibrated")).toContainText("not linked");
  expect(app.page.url()).not.toContain("/linkview/");
  await shotDoc("03-plan-uncalibrated-explained");
  await app.page.getByTestId("lv-uncalibrated-close").click();
  await expect(app.page.getByTestId("lv-uncalibrated")).toHaveCount(0);

  // a link to a plan that is not calibrated falls back to a calibrated one and says so
  const bid = await buildingOf(S102);
  await app.page.evaluate(([id, p]) => (location.hash = `#/linkview/${id}?plan=${p}`), [bid, S102] as const);
  await expect(app.page.getByTestId("lv-note")).toBeVisible({ timeout: 30_000 });
  await expect(app.page.getByTestId("lv-page")).toHaveAttribute("data-plan", S101);
  await shotDoc("04-linkview-fallback-note");
});

test("landscape: plan and 3D side by side, first person at eye height; a tap on the plan moves the 3D camera there", async () => {
  await landscape();
  await expect(app.page.getByTestId("lv-page")).toHaveAttribute("data-dir", "row");
  const p = await box(app.page.getByTestId("lv-plan-pane"));
  const m = await box(app.page.getByTestId("lv-model-pane"));
  expect(p.x + p.width).toBeLessThanOrEqual(m.x + 1); // plan left of 3D
  expect(Math.abs(p.y - m.y)).toBeLessThan(2);
  expect(Math.abs(p.height - m.height)).toBeLessThan(2);
  expect(p.width).toBeGreaterThan(300);
  expect(m.width).toBeGreaterThan(300);
  await paneGeometry("10-linkview-3d-pane");

  // eye height on the plan's storey, looking (near) horizontally
  const st0 = await lv();
  const p0 = await pose();
  expect(p0.pos[1] - st0.walker.floorY).toBeCloseTo(1.6, 1);
  expect(Math.abs(p0.target[1] - p0.pos[1])).toBeLessThan(0.2);
  expect(p0.isOrtho).toBe(false);
  // the 3D camera stands where the marker says
  const mk0 = { x: Number(await app.page.getByTestId("lv-marker").getAttribute("data-page-x")), y: Number(await app.page.getByTestId("lv-marker").getAttribute("data-page-y")) };
  const w0 = toWorld(st0.params!, mk0);
  expect(Math.hypot(w0.x - p0.pos[0], w0.z - p0.pos[2])).toBeLessThan(0.15);

  // tap on the plan: the marker goes there and the 3D camera follows (an independent computation of the world point)
  const tapped = await freePlanTarget();
  await touch.tap(tapped.screen.x, tapped.screen.y);
  const marker = app.page.getByTestId("lv-marker");
  await expect.poll(async () => Math.hypot(Number(await marker.getAttribute("data-page-x")) - tapped.page.x, Number(await marker.getAttribute("data-page-y")) - tapped.page.y), { timeout: 10_000 }).toBeLessThan(3);
  const want = toWorld(st0.params!, tapped.page);
  await expect
    .poll(async () => {
      const e = eye(await pose());
      return Math.hypot(e.x - want.x, e.z - want.z);
    }, { timeout: 15_000 })
    .toBeLessThan(0.2);
  const p1 = await pose();
  expect(p1.pos[1] - st0.walker.floorY).toBeCloseTo(1.6, 1); // still eye height
  expect(Math.abs(angDiff(eye(p1).bearing, eye(p0).bearing))).toBeLessThan(3); // a tap moves, it does not turn
  await app.page.waitForTimeout(1500);
  await shotDoc("11-linkview-tap-to-move");
});

test("drag the wedge handle: the marker and the 3D view turn together", async () => {
  await landscape();
  const marker = app.page.getByTestId("lv-marker");
  const st = await lv();
  const handle = await center(app.page.getByTestId("lv-handle"));
  expect(Math.min(handle.w, handle.h)).toBeGreaterThanOrEqual(44);
  const c0 = { x: Number(await marker.getAttribute("data-screen-x")), y: Number(await marker.getAttribute("data-screen-y")) };
  const viewer = await box(app.page.getByTestId("plan-viewer"));
  const origin = { x: viewer.x + c0.x, y: viewer.y + c0.y };
  const before = eye(await pose()).bearing;
  // drag the handle a quarter turn clockwise on the screen around the marker (the plan is not rotated: screen angle = page heading)
  const h0 = Math.atan2(handle.y - origin.y, handle.x - origin.x);
  const target = h0 + Math.PI / 2;
  const r = 90;
  await touch.drag(handle.x, handle.y, origin.x + r * Math.cos(target), origin.y + r * Math.sin(target), 14);
  const headingPage = target; // page heading = screen angle on an unrotated plan
  const wantBearing = headingPage + st.params!.rotation; // world bearing = page heading + calibration rotation
  await expect.poll(async () => angDiff(eye(await pose()).bearing, wantBearing), { timeout: 15_000 }).toBeLessThan(4);
  await expect.poll(async () => angDiff((Number(await marker.getAttribute("data-heading-deg")) * Math.PI) / 180, headingPage), { timeout: 5000 }).toBeLessThan(4);
  const after = eye(await pose()).bearing;
  expect(angDiff(after, before)).toBeGreaterThan(60); // it really turned
  // turning never moves the camera
  const p = await pose();
  const w = toWorld(st.params!, { x: Number(await marker.getAttribute("data-page-x")), y: Number(await marker.getAttribute("data-page-y")) });
  expect(Math.hypot(w.x - p.pos[0], w.z - p.pos[2])).toBeLessThan(0.2);
  await app.page.waitForTimeout(1200);
  await shotDoc("12-linkview-drag-to-turn");
});

test("walking and looking in 3D moves and turns the marker", async () => {
  await landscape();
  const marker = app.page.getByTestId("lv-marker");
  const st = await lv();
  const p0 = await pose();
  const m0 = { x: Number(await marker.getAttribute("data-page-x")), y: Number(await marker.getAttribute("data-page-y")) };
  const h0 = Number(await marker.getAttribute("data-heading-deg"));

  // drag in the 3D pane = look around (drag left turns left)
  const layer = await center(app.page.getByTestId("walk-layer"));
  await touch.drag(layer.x + 80, layer.y - 20, layer.x - 80, layer.y - 20, 14);
  await app.page.waitForTimeout(500);
  const p1 = await pose();
  expect(angDiff(eye(p1).bearing, eye(p0).bearing)).toBeGreaterThan(10);
  await expect.poll(async () => angDiff((Number(await marker.getAttribute("data-heading-deg")) * Math.PI) / 180, eye(p1).bearing - st.params!.rotation), { timeout: 5000 }).toBeLessThan(3);
  expect(Math.abs(Number(await marker.getAttribute("data-heading-deg")) - h0)).toBeGreaterThan(5);

  // the move pad: hold it forward
  const pad = await center(app.page.getByTestId("walk-pad"));
  const cdp = await app.page.context().newCDPSession(app.page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: pad.x, y: pad.y, id: 1 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: pad.x, y: pad.y - 55, id: 1 }] });
  await app.page.waitForTimeout(1800);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
  await app.page.waitForTimeout(600);
  const p2 = await pose();
  const walked = Math.hypot(p2.pos[0] - p1.pos[0], p2.pos[2] - p1.pos[2]);
  console.log("walked", walked.toFixed(2), "m");
  expect(walked).toBeGreaterThan(0.3);
  // the marker is where the camera is (independent inverse of the calibration), and it moved from where it was
  const m2 = toPage(st.params!, { x: p2.pos[0], z: p2.pos[2] });
  const shown = { x: Number(await marker.getAttribute("data-page-x")), y: Number(await marker.getAttribute("data-page-y")) };
  expect(Math.hypot(shown.x - m2.x, shown.y - m2.y)).toBeLessThan(2.5);
  expect(Math.hypot(shown.x - m0.x, shown.y - m0.y)).toBeGreaterThan(walked / st.params!.scale / 3);
  await shotDoc("13-linkview-3d-walk-updates-marker");
});

test("storey change: the 3D level picker switches the plan; a level without a plan is explained; a level chip brings the plan back", async () => {
  await landscape();
  const page = app.page;
  expect((await lv()).storey).toBe("101 FIRST FLOOR");
  // up one level in the 3D view's own level picker
  await page.getByTestId("walk-level-up").click();
  await expect(page.getByTestId("lv-page")).not.toHaveAttribute("data-storey", "101 FIRST FLOOR", { timeout: 10_000 });
  const upName = (await page.getByTestId("lv-page").getAttribute("data-storey"))!;
  console.log("level up ->", upName);
  await expect(page.getByTestId("lv-no-plan")).toBeVisible();
  await expect(page.getByTestId("lv-no-plan")).toContainText(upName);
  await expect(page.getByTestId("lv-level-noplan")).toBeVisible();
  expect(await page.getByTestId("model-page").getAttribute("data-mode")).toBe("walk"); // 3D keeps working
  const st = await lv();
  const p = await pose();
  expect(p.pos[1] - st.walker.floorY).toBeCloseTo(1.6, 1);
  expect(st.walker.floorY).toBeGreaterThan(1);
  await shotDoc("20-linkview-level-without-plan");

  // a level chip with a plan: the plan and the floor come back
  await page.getByTestId("lv-level").filter({ hasText: "101 FIRST FLOOR" }).click();
  await expect(page.getByTestId("lv-page")).toHaveAttribute("data-storey", "101 FIRST FLOOR");
  await expect(page.getByTestId("lv-no-plan")).toHaveCount(0);
  await expect(page.getByTestId("lv-marker")).toBeVisible({ timeout: 20_000 });
  await expect.poll(async () => (await pose()).pos[1], { timeout: 10_000 }).toBeCloseTo(1.6, 0);
  expect(Math.abs((await pose()).pos[1] - 1.6)).toBeLessThan(0.15);
  await shotDoc("21-linkview-level-chip-back");
});

test("a second calibrated plan: the level picker and the level chips swap plans, the camera keeps its place", async () => {
  await landscape();
  const page = app.page;
  // add a calibration of S-102 on the second floor straight into the device database (a new mount reads it)
  const params = (await lv()).params!;
  await page.evaluate(
    ([pdf, p]) =>
      new Promise<void>((res, rej) => {
        const open = indexedDB.open("free-field");
        open.onerror = () => rej(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction("calibrations", "readwrite");
          tx.objectStore("calibrations").put({
            id: "e2e-cal-s102",
            projectId: "default-project",
            pdfFileId: pdf,
            storeyName: "201 SECOND FLOOR",
            pointPairs: [
              { pdfX: 100, pdfY: 100, worldX: 0, worldZ: 0 },
              { pdfX: 300, pdfY: 100, worldX: 7, worldZ: 0 },
            ],
            transformParams: p,
            confidence: 1,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
          tx.oncomplete = () => res();
          tx.onerror = () => rej(tx.error);
        };
      }),
    [S102, params] as const,
  );
  // Dexie caches live query results until it hears of a change, and a raw write is not one: reload the app to read it
  await page.goto(page.url().split("#")[0] + "#/model");
  await page.reload();
  const demo = page.getByTestId("demo-signin");
  const tabs = page.getByTestId("tabs");
  await expect(demo.or(tabs)).toBeVisible({ timeout: 60_000 });
  if (await demo.isVisible()) await demo.click();
  const picker = page.getByTestId("project-picker");
  await expect(picker.or(tabs)).toBeVisible();
  if (await picker.isVisible()) await page.getByTestId("project-default-project").click();
  await expect(tabs).toBeVisible();
  await goTab("Model");
  await waitReady(page);
  await page.getByTestId("model-linkview").click();
  await expect(page.getByTestId("lv-picker")).toBeVisible();
  const rows = page.getByTestId("lv-pick-plan");
  await expect(rows).toHaveCount(2);
  expect((await box(rows.first())).height).toBeGreaterThanOrEqual(44);
  await shotDoc("30-entry-from-3d-picker");
  await rows.filter({ hasText: "101 FIRST FLOOR" }).click();
  await linkviewReady();
  await expect(page.getByTestId("lv-page")).toHaveAttribute("data-plan", S101);
  await expect(page.getByTestId("lv-level")).toHaveCount(2);

  // up with the 3D level picker: the plan becomes S-102
  await page.getByTestId("walk-level-up").click();
  await expect(page.getByTestId("lv-page")).toHaveAttribute("data-storey", "201 SECOND FLOOR", { timeout: 10_000 });
  await expect(page.getByTestId("lv-page")).toHaveAttribute("data-plan", S102);
  await expect(page.getByTestId("lv-plan-pane").locator('[data-testid="plan-viewer"], [data-testid="lv-plan-preparing"]')).toBeVisible({ timeout: 60_000 });
  const st = await lv();
  const pz = await pose();
  expect(pz.pos[1] - st.walker.floorY).toBeCloseTo(1.6, 1);
  expect(st.walker.floorY).toBeGreaterThan(2);
  await expect(page.getByTestId("lv-marker").or(page.getByTestId("lv-outside"))).toBeVisible({ timeout: 60_000 });
  await shotDoc("31-linkview-second-plan");

  // back down with the level chip of the first plan
  await page.getByTestId("lv-level").filter({ hasText: "101 FIRST FLOOR" }).click();
  await expect(page.getByTestId("lv-page")).toHaveAttribute("data-plan", S101);
  await expect.poll(async () => Math.abs((await pose()).pos[1] - 1.6), { timeout: 10_000 }).toBeLessThan(0.15);
});

test("portrait: plan above 3D; swap the panes; drag the divider; one viewer the whole time", async () => {
  await portrait();
  const page = app.page;
  await expect(page.getByTestId("lv-page")).toHaveAttribute("data-dir", "column");
  const reg0 = await dbg(page, (d) => d.registry());
  expect(reg0).toMatchObject({ live: 1, overlaps: 0 });
  let p = await box(page.getByTestId("lv-plan-pane"));
  let m = await box(page.getByTestId("lv-model-pane"));
  expect(p.y + p.height).toBeLessThanOrEqual(m.y + 1); // plan above 3D
  expect(Math.abs(p.x - m.x)).toBeLessThan(2);
  expect(Math.abs(p.width - m.width)).toBeLessThan(2);
  // the toolbar follows the shape of the 3D pane (rail when it is wider than tall), not of the screen
  await expect(page.getByTestId("model-tools")).toHaveAttribute("data-layout", m.width > m.height ? "rail" : "bar");
  await expect(page.getByTestId("lv-marker")).toBeVisible();
  await paneGeometry("40-linkview-portrait-3d");
  await shotDoc("40-linkview-portrait");

  // swap: 3D on top, plan below, same viewer instance
  await page.getByTestId("lv-swap").click();
  await expect(page.getByTestId("lv-page")).toHaveAttribute("data-swapped", "1");
  p = await box(page.getByTestId("lv-plan-pane"));
  m = await box(page.getByTestId("lv-model-pane"));
  expect(m.y + m.height).toBeLessThanOrEqual(p.y + 1);
  await page.waitForTimeout(1200);
  await shotDoc("41-linkview-portrait-swapped");
  await expect(page.getByTestId("model-page")).toHaveAttribute("data-mode", "walk");

  // the divider: drag it up, the plan (now below) grows; nothing is rebuilt
  const hBefore = (await box(page.getByTestId("lv-plan-pane"))).height;
  const dv = await center(page.getByTestId("lv-divider"));
  expect(Math.min(dv.w, dv.h)).toBeGreaterThanOrEqual(24);
  await touch.drag(dv.x, dv.y, dv.x, dv.y - 140, 12);
  await expect.poll(async () => (await box(page.getByTestId("lv-plan-pane"))).height, { timeout: 10_000 }).toBeGreaterThan(hBefore + 80);
  await page.waitForTimeout(1500);
  await expect(page.getByTestId("lv-marker")).toBeVisible();
  const reg1 = await dbg(page, (d) => d.registry());
  expect(reg1.acquired).toBe(reg0.acquired); // resizing and swapping never rebuilt the viewer
  expect(reg1).toMatchObject({ live: 1, overlaps: 0 });
  expect(Math.min((await box(page.getByTestId("lv-plan-pane"))).height, (await box(page.getByTestId("lv-model-pane"))).height)).toBeGreaterThanOrEqual(160);
  await shotDoc("42-linkview-portrait-resized");
  await page.getByTestId("lv-swap").click(); // back to plan first for the next tests
});

test("task pins show in both panes; long press on the plan creates a task and returns to the Link view", async () => {
  await landscape();
  const page = app.page;
  const st = await lv();
  const bid = (await page.getByTestId("lv-page").getAttribute("data-building"))!;
  const m = page.getByTestId("lv-marker");
  const mp = { x: Number(await m.getAttribute("data-page-x")), y: Number(await m.getAttribute("data-page-y")) };
  // a plan-only task a little beside the marker, and a 3D-only task at the matching world point on the other side
  const uv: [number, number] = [(mp.x + 40) / st.page!.width, (mp.y + 30) / st.page!.height];
  const planTask = await page.evaluate(
    ([id, u, b]) => window.__ffmTest!.createTask("Plan-only pin", { buildingId: b as string, location: { storeyName: null, bim: null, pdf: { pdfFileId: id as string, page: 1, uv: u as [number, number], calibId: "e2e" } } }),
    [S101, uv, bid] as const,
  );
  const w = toWorld(st.params!, { x: mp.x - 40, y: mp.y - 30 });
  const bimTask = await page.evaluate(
    ([b, x, y, z]) => window.__ffmTest!.createTask("Model-only pin", { buildingId: b as string, location: { storeyName: null, bim: { elements: [], worldPoint: [x, y, z] }, pdf: null } }),
    [bid, w.x, st.walker.floorY + 1.2, w.z] as const,
  );
  await expect(page.locator(`[data-testid="plan-pin"][data-task-id="${planTask}"]`)).toHaveCount(1, { timeout: 30_000 }); // plan pin on the plan
  await expect(page.locator(`[data-testid="plan-pin"][data-task-id="${bimTask}"]`)).toHaveCount(1, { timeout: 30_000 }); // 3D task projected onto the plan
  await expect(page.locator(`[data-testid="model-pin"][data-task-id="${planTask}"]`)).toHaveCount(1, { timeout: 30_000 }); // plan task placed in 3D
  await expect(page.locator(`[data-testid="model-pin"][data-task-id="${bimTask}"]`)).toHaveCount(1);
  await page.waitForTimeout(800);
  await shotDoc("50-linkview-task-pins");

  // long press on an empty spot of the plan: "New task here" appears, the form opens at that spot, Close returns to the Link view
  const t = await planTarget(0, 150);
  const press = await touch.press(t.screen.x, t.screen.y);
  await page.waitForTimeout(900);
  await press.release();
  await expect(page.getByTestId("plan-new-task")).toBeVisible({ timeout: 10_000 });
  await page.getByTestId("plan-new-task").click();
  await expect(page).toHaveURL(/\/tasks\/new/);
  expect(page.url()).toContain("back=");
  await shotDoc("51-linkview-new-task-form");
  await page.getByRole("button", { name: /^(close|cancel)/i }).first().click();
  await expect(page.getByTestId("lv-page")).toBeVisible({ timeout: 30_000 });
  await expect(page).toHaveURL(/\/linkview\//);
  await waitReady(page);
  await expect(page.getByTestId("model-page")).toHaveAttribute("data-mode", "walk", { timeout: 30_000 });
  await expect(page.getByTestId("lv-marker")).toBeVisible();
});

test("the renderer recovery net holds: a lost GL context reloads the model and the walker stands where it was", async () => {
  await landscape();
  const page = app.page;
  const before = await pose();
  const mk = { x: await page.getByTestId("lv-marker").getAttribute("data-page-x"), y: await page.getByTestId("lv-marker").getAttribute("data-page-y") };
  expect(await dbg(page, (d) => d.loseContext())).toBe(true);
  await expect(page.getByTestId("model-page")).toHaveAttribute("data-phase", /reloading|loading/, { timeout: 30_000 });
  await waitReady(page, 180_000);
  await expect(page.getByTestId("model-page")).toHaveAttribute("data-mode", "walk", { timeout: 60_000 });
  await page.waitForTimeout(1500);
  const after = await pose();
  expect(Math.hypot(after.pos[0] - before.pos[0], after.pos[2] - before.pos[2])).toBeLessThan(0.2);
  expect(Math.abs(after.pos[1] - before.pos[1])).toBeLessThan(0.05);
  expect(angDiff(eye(after).bearing, eye(before).bearing)).toBeLessThan(3);
  expect(await page.getByTestId("lv-marker").getAttribute("data-page-x")).toBe(mk.x);
  expect(await dbg(page, (d) => d.registry())).toMatchObject({ live: 1, overlaps: 0 });
  await paneGeometry("60-linkview-after-recovery");
});

test("offline: the Link view opens and works in airplane mode; leaving it releases the viewer", async () => {
  await landscape();
  const page = app.page;
  await app.shell("cmd connectivity airplane-mode enable");
  await page.waitForTimeout(1500);
  await goTab("Plans");
  await planRow("S-101").getByTestId("plan-open").click();
  await expect(page.getByTestId("plan-viewer")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("plan-linkview").click();
  await linkviewReady();
  const t = await freePlanTarget();
  const st = t.st;
  await touch.tap(t.screen.x, t.screen.y);
  const want = toWorld(st.params!, t.page);
  await expect.poll(async () => Math.hypot(eye(await pose()).x - want.x, eye(await pose()).z - want.z), { timeout: 15_000 }).toBeLessThan(0.25);
  await shotDoc("70-linkview-offline");
  await app.shell("cmd connectivity airplane-mode disable");
  // leaving the Link view releases the viewer; the Model tab then builds exactly one again
  await goTab("Tasks");
  await gotoModel(app);
  expect(await dbg(page, (d) => d.registry())).toMatchObject({ live: 1, overlaps: 0 });
});


// ── overlay mode (docs/spikes/parity-views) ──────────────────────────
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
/** Set a range input the way a drag would (React listens to the native `input` event). */
const setRange = (id: string, value: number) =>
  app.page.getByTestId(id).evaluate((el, v) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    set.call(el, String(v));
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
const planOpacity = () => app.page.getByTestId("lv-plan-pane").evaluate((el) => Number(getComputedStyle(el).opacity));

test("overlay mode: the plan over the 3D with an opacity slider; split and overlay toggle without reloading the 3D; first person and the marker link stay", async () => {
  await landscape();
  if (!(await app.page.getByTestId("lv-page").count())) {
    await openPlan("S-101");
    await app.page.getByTestId("plan-linkview").click();
  }
  await linkviewReady();
  await expect(app.page.getByTestId("lv-page")).toHaveAttribute("data-mode", "split");
  await expect(app.page.getByTestId("lv-overlay-ctl")).toHaveCount(0);
  for (const id of ["lv-mode-split", "lv-mode-overlay"]) expect((await box(app.page.getByTestId(id))).height, id).toBeGreaterThanOrEqual(44);
  const acquired = (await dbg(app.page, (d) => d.registry())).acquired;
  const st0 = await lv();
  const p0 = await pose();
  await parityShot("60-linkview-split");

  // split -> overlay: one pane over the other, the plan translucent
  await app.page.getByTestId("lv-mode-overlay").click();
  await expect(app.page.getByTestId("lv-page")).toHaveAttribute("data-mode", "overlay");
  await expect(app.page.getByTestId("lv-overlay-ctl")).toBeVisible();
  await expect(app.page.getByTestId("lv-marker")).toBeVisible();
  const p = await box(app.page.getByTestId("lv-plan-pane"));
  const m = await box(app.page.getByTestId("lv-model-pane"));
  for (const k of ["x", "y", "width", "height"] as const) expect(Math.abs(p[k] - m[k]), `plan and 3D share the ${k}`).toBeLessThan(2);
  expect(m.width, "the 3D fills the area").toBeGreaterThan(p.width * 0.9);
  expect(await planOpacity()).toBeCloseTo(0.6, 2);
  await app.page.waitForTimeout(2000);
  await paneGeometry("61-linkview-overlay-3d-under-plan");
  await parityShot("61-linkview-overlay-60");

  // the slider
  await setRange("lv-opacity", 25);
  await expect(app.page.getByTestId("lv-opacity-value")).toHaveText("25%");
  expect(await planOpacity()).toBeCloseTo(0.25, 2);
  await app.page.waitForTimeout(800);
  await parityShot("62-linkview-overlay-25");
  await setRange("lv-opacity", 100);
  expect(await planOpacity()).toBe(1);
  await setRange("lv-opacity", 60);

  // first person at eye height, same place; the 3D was not rebuilt
  const p1 = await pose();
  expect(p1.pos[1] - st0.walker.floorY).toBeCloseTo(1.6, 1);
  expect(Math.hypot(p1.pos[0] - p0.pos[0], p1.pos[2] - p0.pos[2])).toBeLessThan(0.05);
  expect(await app.page.getByTestId("model-page").getAttribute("data-mode")).toBe("walk");
  expect((await dbg(app.page, (d) => d.registry())).acquired).toBe(acquired);

  // a tap on the plan still moves the 3D camera (touch goes to the plan by default)
  const tapped = await freePlanTarget();
  const mk = app.page.getByTestId("lv-marker");
  console.log("OVERLAY TAP", JSON.stringify({ tapped, marker: { x: await mk.getAttribute("data-page-x"), y: await mk.getAttribute("data-page-y") } }));
  await touch.tap(tapped.screen.x, tapped.screen.y);
  await expect.poll(async () => Math.hypot(Number(await mk.getAttribute("data-page-x")) - tapped.page.x, Number(await mk.getAttribute("data-page-y")) - tapped.page.y), { timeout: 10_000, message: "the marker goes where the plan was tapped" }).toBeLessThan(3);
  const want = toWorld(st0.params!, tapped.page);
  await expect
    .poll(async () => {
      const e = eye(await pose());
      return Math.hypot(e.x - want.x, e.z - want.z);
    }, { timeout: 15_000 })
    .toBeLessThan(0.2);
  expect((await pose()).pos[1] - st0.walker.floorY).toBeCloseTo(1.6, 1);

  // "Use 3D": touches pass through the plan to the 3D view
  await app.page.getByTestId("lv-touch-3d").click();
  await expect(app.page.getByTestId("lv-touch-3d")).toHaveAttribute("aria-pressed", "true");
  expect(await app.page.getByTestId("plan-viewer").evaluate((el) => getComputedStyle(el).pointerEvents)).toBe("none");
  await app.page.waitForTimeout(500);
  await parityShot("63-linkview-overlay-use-3d");
  await app.page.getByTestId("lv-touch-plan").click();
  expect(await app.page.getByTestId("plan-viewer").evaluate((el) => getComputedStyle(el).pointerEvents)).not.toBe("none");

  // overlay -> split: side by side again, plan opaque, the camera where the tap left it
  const before = await pose();
  await app.page.getByTestId("lv-mode-split").click();
  await expect(app.page.getByTestId("lv-page")).toHaveAttribute("data-mode", "split");
  await expect(app.page.getByTestId("lv-overlay-ctl")).toHaveCount(0);
  const ps = await box(app.page.getByTestId("lv-plan-pane"));
  const ms = await box(app.page.getByTestId("lv-model-pane"));
  expect(ps.x + ps.width).toBeLessThanOrEqual(ms.x + 1);
  expect(await planOpacity()).toBe(1);
  const after = await pose();
  expect(Math.hypot(after.pos[0] - before.pos[0], after.pos[2] - before.pos[2])).toBeLessThan(0.05);
  expect((await dbg(app.page, (d) => d.registry())).acquired).toBe(acquired);
  await app.page.waitForTimeout(1200);
  await parityShot("64-linkview-back-to-split");

  // the choice is remembered: overlay again, leave the screen and come back
  await app.page.getByTestId("lv-mode-overlay").click();
  await app.page.getByTestId("lv-back").click();
  await expect(app.page.getByTestId("lv-page")).toHaveCount(0, { timeout: 15_000 });
  await openPlan("S-101");
  await app.page.getByTestId("plan-linkview").click();
  await linkviewReady();
  await expect(app.page.getByTestId("lv-page")).toHaveAttribute("data-mode", "overlay");
  await app.page.getByTestId("lv-mode-split").click();
});
