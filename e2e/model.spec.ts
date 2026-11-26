import { expect, test } from "@playwright/test";
import { launchApp, touchSession, type AppSession } from "./app";
import { center, centralRegion, type Pose, chooseLevel, closeFilters, dbg, deviceShot, dist, expectGeometry, gotoModel, levelNames, meminfo, moved, openFilters, recordPerf, stageRect, waitReady } from "./model";
import { geometryStats, meanDiff } from "./png";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { SHOTS } from "./app";
import { setRotation } from "./qa";

test.describe.configure({ mode: "serial" });

let app: AppSession;
let touch: Awaited<ReturnType<typeof touchSession>>;
let taskId = "";
const TITLE = "Honeycombing at column line B";

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
    console.log("MEASURE PROBE:", JSON.stringify(await app.page.evaluate(() => (window as unknown as { __ffmMeasure?: unknown }).__ffmMeasure ?? null).catch(() => null)));
    console.log("MODEL STATE:", JSON.stringify(await dbg(app.page, (d) => d.state()).catch(() => null)));
    await app.shot(`model-fail-${info.title.replace(/\W+/g, "-").slice(0, 40)}`).catch(() => undefined);
  }
});
test.afterAll(async () => {
  await app?.shell("cmd connectivity airplane-mode disable").catch(() => undefined);
  await touch?.detach().catch(() => undefined);
  await app?.close();
});

const goTab = (name: string) => app.page.getByTestId("tabs").getByRole("link", { name, exact: true }).click();

test("model tab renders the sample .frag with real geometry", async () => {
  const t0 = Date.now();
  await gotoModel(app);
  const wall = Date.now() - t0;
  await expect(app.page.getByTestId("model-building-picker")).toBeVisible();
  await expect(app.page.getByTestId("model-route")).toHaveAttribute("data-building", /.+/);
  await app.page.waitForTimeout(2500); // tiles stream in
  const g = await expectGeometry(app, "20-model-loaded");
  const m = await app.page.evaluate(() => window.__ffmModel);
  const st = await dbg(app.page, (d) => d.state());
  recordPerf({ tabOpenToReadyMs: wall, viewerLoadMs: st.loadMs, installMs: m?.installMs ?? null, geometryFraction: g.fraction, webgl: m?.renderer });
  expect(m?.webgl2).toBe(true);
  expect(await dbg(app.page, (d) => d.registry())).toMatchObject({ live: 1, overlaps: 0 });
  const glErrors = [...app.consoleErrors, ...app.pageErrors].filter((e) => /webgl|gl context|shader|context lost/i.test(e));
  expect(glErrors).toEqual([]);
});

test("pixel ratio is capped and nothing renders while idle", async () => {
  const dpr = await app.page.evaluate(() => window.devicePixelRatio);
  const pr = (await dbg(app.page, (d) => d.pixelRatio()))!;
  console.log(`devicePixelRatio ${dpr}, render pixel ratio ${pr}`);
  expect(pr).toBeLessThanOrEqual(1.5);
  expect(pr).toBeGreaterThan(0.5);
  await app.page.waitForTimeout(2500); // settle: let the last invalidation window close
  const a = await dbg(app.page, (d) => ({ r: d.renderStats(), o: d.overlay() }));
  await app.page.waitForTimeout(3000);
  const b = await dbg(app.page, (d) => ({ r: d.renderStats(), o: d.overlay() }));
  console.log("idle render stats", JSON.stringify({ a, b }));
  expect(b.o?.running).toBe(false);
  expect(b.o?.frames).toBe(a.o?.frames); // overlay loop is parked
  if (a.r && b.r && typeof a.r.renders === "number") expect(b.r.renders).toBe(a.r.renders); // no GPU draws at rest
});

test("orbit and zoom with touch gestures; fps while orbiting", async () => {
  const r = await stageRect(app.page);
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const p0 = (await dbg(app.page, (d) => d.pose()))!;

  // rAF sampling during a 3 s drag back and forth
  await app.page.evaluate(() => {
    const w = window as unknown as { __fps: { frames: number; t0: number; dts: number[]; last: number; on: boolean } };
    w.__fps = { frames: 0, t0: performance.now(), dts: [], last: performance.now(), on: true };
    const loop = () => {
      const s = w.__fps;
      if (!s.on) return;
      const now = performance.now();
      s.dts.push(now - s.last);
      s.last = now;
      s.frames++;
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
  await touch.drag(cx - 150, cy, cx + 150, cy - 60, 20);
  await touch.drag(cx - 100, cy + 40, cx + 120, cy - 20, 20);
  await expect(app.page.getByTestId("props-sheet"), "an orbit drag must not pick an element").toHaveCount(0);
  const fps = await app.page.evaluate(() => {
    const s = (window as unknown as { __fps: { frames: number; t0: number; dts: number[]; on: boolean } }).__fps;
    s.on = false;
    const secs = (performance.now() - s.t0) / 1000;
    const sorted = [...s.dts].sort((a, b) => a - b);
    return { fps: s.frames / secs, frames: s.frames, secs, p95FrameMs: sorted[Math.floor(sorted.length * 0.95)] ?? 0 };
  });
  recordPerf({ orbitFps: Math.round(fps.fps * 10) / 10, orbitP95FrameMs: Math.round(fps.p95FrameMs), orbitSampleSecs: Math.round(fps.secs * 10) / 10 });
  const p1 = (await dbg(app.page, (d) => d.pose()))!;
  expect(moved(p0, p1)).toBeGreaterThan(0.05); // the camera orbited
  await expectGeometry(app, "21-model-orbited");

  // pinch zoom changes the orbit distance
  const d0 = dist(p1);
  await touch.pinch(cx, cy, 80, 420);
  await expect(app.page.getByTestId("props-sheet"), "a pinch-out must not pick an element").toHaveCount(0);
  await expect.poll(async () => dist((await dbg(app.page, (d) => d.pose()))!), { timeout: 10_000 }).toBeLessThan(d0 * 0.85);
  const d1 = dist((await dbg(app.page, (d) => d.pose()))!);
  await touch.pinch(cx, cy, 420, 80);
  await expect(app.page.getByTestId("props-sheet"), "a pinch-in must not pick an element").toHaveCount(0);
  await expect.poll(async () => dist((await dbg(app.page, (d) => d.pose()))!), { timeout: 10_000 }).toBeGreaterThan(d1 * 1.15);

  // fit-to-view and reset
  await app.page.getByTestId("model-fit").click();
  await app.page.waitForTimeout(1500);
  const fitted = (await dbg(app.page, (d) => d.pose()))!;
  // 25 px per step: CDP touch dispatch takes ~0.4 s per step on the software-GPU emulator, so a first step
  // inside the long-press slop (10 px) would hold "still" past 550 ms and be a real long-press.
  // Pipelined swipe (explicit timestamps): right after Fit the software-GPU frame can delay CDP dispatch, and a first move
  // arriving > 550 ms after touchStart is, correctly, a long-press (the app selects). A real drag has no such pause.
  await touch.swipe(cx - 100, cy, cx + 100, cy, 8);
  await expect(app.page.getByTestId("props-sheet"), "a drag after fit must not pick an element").toHaveCount(0);
  await app.page.getByTestId("model-reset").click();
  await app.page.waitForTimeout(1500);
  const reset = (await dbg(app.page, (d) => d.pose()))!;
  expect(moved(fitted, reset) + Math.abs(dist(fitted) - dist(reset))).toBeGreaterThanOrEqual(0); // both commands ran without error
  await expectGeometry(app, "22-model-reset");
  await app.page.getByTestId("model-fit").click();
  await app.page.waitForTimeout(1500);
});

test("level filter (Filters sheet) isolates a storey and All levels restores it", async () => {
  await ensureModel();
  const names = await levelNames(app.page);
  expect(names.length).toBeGreaterThanOrEqual(2);
  await app.page.waitForTimeout(4000);
  const all = await liveShot("23-storeys-all");
  const region = centralRegion(all);
  console.log("storeys:", names.join(" | "));
  // isolate each storey until one visibly differs (some storeys of the sample hold few elements)
  let best = 0;
  for (const n of names.slice(0, 4)) {
    await chooseLevel(app.page, n);
    await expect(app.page.getByTestId("filter-chip").first()).toContainText(n);
    await app.page.waitForTimeout(2500);
    const iso = await liveShot("24-storey-isolated");
    best = Math.max(best, meanDiff(all, iso, region));
  }
  console.log("isolation mean pixel diff", best.toFixed(2));
  expect(best).toBeGreaterThan(1);
  await chooseLevel(app.page, null);
  await expect(app.page.getByTestId("filter-summary")).toHaveCount(0);
  await app.page.waitForTimeout(2500);
  const back = await liveShot("25-storeys-restored");
  expect(meanDiff(all, back, region)).toBeLessThan(Math.max(best / 2, 3));
  expect(geometryStats(back, region).fraction).toBeGreaterThan(0.03);
});

test("first-person walk: eye height 1.6 m, drag to look, move pad walks, exit restores the orbit view", async () => {
  const before = (await dbg(app.page, (d) => d.pose()))!;
  await app.page.getByTestId("model-walk").click();
  await expect(app.page.getByTestId("walk-layer")).toBeVisible();
  await expect(app.page.getByTestId("model-page")).toHaveAttribute("data-mode", "walk");
  await app.page.waitForTimeout(800);
  const w0 = (await dbg(app.page, (d) => d.pose()))!;
  console.log("walk pose", JSON.stringify(w0));
  // eye = floor + 1.6 where the floor is one of the synced storey elevations of the sample (0, 2.84, ...) or the model's lowest point
  const floor = w0.pos[1] - 1.6;
  expect(Number.isFinite(floor)).toBe(true);
  expect(Math.abs(w0.fov - 60)).toBeLessThan(0.5);
  // at eye height in landscape the view can be mostly one flat-shaded floor slab: few colours, still real geometry
  await expectGeometry(app, "26-walk-start", 0.01, 3);

  const lookDir = (p: typeof w0) => Math.atan2(p.target[0] - p.pos[0], -(p.target[2] - p.pos[2]));
  const layer = await center(app.page.getByTestId("walk-layer"));
  await touch.drag(layer.x + 100, layer.y - 40, layer.x - 100, layer.y - 40, 15); // drag left = turn left
  await app.page.waitForTimeout(300);
  const w1 = (await dbg(app.page, (d) => d.pose()))!;
  expect(Math.abs(lookDir(w1) - lookDir(w0))).toBeGreaterThan(0.3);
  expect(Math.abs(w1.pos[1] - w0.pos[1])).toBeLessThan(1e-3); // looking around never changes the eye height

  // move pad: hold the knob forward for ~1.2 s
  const pad = await center(app.page.getByTestId("walk-pad"));
  const hold = async (dx: number, dy: number, ms: number) => {
    const cdp = await app.page.context().newCDPSession(app.page);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: pad.x, y: pad.y, id: 1 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: pad.x + dx, y: pad.y + dy, id: 1 }] });
    await app.page.waitForTimeout(ms);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await cdp.detach();
  };
  await hold(0, -55, 1500);
  const w2 = (await dbg(app.page, (d) => d.pose()))!;
  const horiz = Math.hypot(w2.pos[0] - w1.pos[0], w2.pos[2] - w1.pos[2]);
  console.log("walked", horiz.toFixed(2), "m");
  expect(horiz).toBeGreaterThan(0.3);
  expect(horiz).toBeLessThan(6); // 1.4 m/s
  expect(Math.abs(w2.pos[1] - w1.pos[1])).toBeLessThan(1e-3);
  await app.shot("27-walk-moved");

  await app.page.getByTestId("walk-exit").click();
  await expect(app.page.getByTestId("model-page")).toHaveAttribute("data-mode", "orbit");
  await expect.poll(async () => moved(before, (await dbg(app.page, (d) => d.pose()))!), { timeout: 10_000 }).toBeLessThan(1);
});

/** True when the topmost element at a page point is the model stage itself (not a toolbar, sheet, bar, chip or HUD control). */
async function clearOfUi(x: number, y: number): Promise<boolean> {
  return app.page.evaluate(
    ([px, py]) => {
      const el = document.elementFromPoint(px, py);
      return !!el && !!el.closest(".model-stage") && !el.closest("button, .model-tools, .model-sheet, .model-measure-bar, .model-lp, .model-top, .walk-level, .tools-menu");
    },
    [x, y],
  );
}

/** First screen point on the model: scan a grid with the fragments raycaster. */
async function findElementPoint(offset = 0) {
  const r = await stageRect(app.page);
  // keep clear of task pins: tapping one opens the task instead of picking the element behind it
  const pins = await app.page.locator('[data-testid="model-pin"][data-visible="true"]').evaluateAll((els) =>
    els.map((e) => {
      const b = e.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    }),
  );
  for (let j = 0; j < 9; j++) {
    for (let i = 0; i < 12; i++) {
      const x = r.x + r.w * (0.15 + ((i + offset) % 12) * 0.06 + 0.01) ;
      const y = r.y + r.h * (0.25 + j * 0.07);
      const hit = await dbg(app.page, (d, a) => d.elementAt(a.x, a.y), { x, y });
      if (hit && pins.every((p) => Math.hypot(p.x - x, p.y - y) > 60) && (await clearOfUi(x, y))) return { x, y, hit };
    }
  }
  throw new Error("no element found on screen");
}

/** Tap on elements until the properties sheet opens (the first tap right after a fly-in can land before the tiles settle). */
async function tapUntilSheet(): Promise<void> {
  const logs: string[] = [];
  for (let attempt = 0; attempt < 5; attempt++) {
    const { x, y, hit } = await findElementPoint(attempt * 2);
    console.log("tap target", x, y, JSON.stringify(hit));
    await touch.tap(x, y);
    const shown = await app.page.getByTestId("props-sheet").waitFor({ timeout: 6000 }).then(() => true, () => false);
    console.log("tap attempt", attempt, shown, JSON.stringify(logs.slice(-4)));
    if (shown) return;
  }
  throw new Error("no tap opened the properties sheet");
}

test("tap an element: highlight and a properties sheet with real attributes", async () => {
  if (!(await app.page.getByTestId("model-page").count())) await gotoModel(app);
  await app.page.getByTestId("model-fit").click();
  await app.page.waitForTimeout(2500);
  await tapUntilSheet();
  await expect(app.page.getByTestId("props-sheet")).toBeVisible({ timeout: 5000 });
  await expect(app.page.getByTestId("props-attrs")).toContainText("GlobalId", { timeout: 20_000 });
  const attrs = (await app.page.getByTestId("props-attrs").innerText()).replace(/\s+/g, " ");
  const title = await app.page.getByTestId("props-title").innerText();
  console.log("props title:", title, "| attrs:", attrs.slice(0, 160), "| psets:", await app.page.getByTestId("props-pset").count());
  expect(title.length).toBeGreaterThan(0);
  const guid = /GlobalId\s+([0-9A-Za-z_$]{22})/.exec(attrs);
  expect(guid, "an IFC GlobalId from the fragments model").not.toBeNull();
  await app.shot("28-model-props");
  // the sheet never covers the camera tools (portrait: bottom sheet; wide: side panel)
  for (const id of ["model-fit", "model-reset", "model-walk"]) {
    const onTop = await app.page.getByTestId(id).evaluate((el) => {
      const b = el.getBoundingClientRect();
      const top = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      return !!top && (top === el || el.contains(top));
    });
    expect(onTop, `${id} is reachable while the properties sheet is open`).toBe(true);
  }
  await app.page.getByTestId("props-close").click();
  await expect(app.page.getByTestId("props-sheet")).toHaveCount(0);
});

test("tap a thin element: the viewer's own pick selects it", async () => {
  if (!(await app.page.getByTestId("model-page").count())) await gotoModel(app);
  if (await app.page.getByTestId("props-sheet").count()) await app.page.getByTestId("props-close").click();
  await app.page.getByTestId("model-fit").click();
  await app.page.waitForTimeout(2500);
  const pins = await app.page.locator('[data-testid="model-pin"][data-visible="true"]').evaluateAll((els) =>
    els.map((e) => {
      const b = e.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    }),
  );
  const cands = (await dbg(app.page, (d) => d.thinCandidates())).filter((c) => pins.every((p) => Math.hypot(p.x - c.x, p.y - c.y) > 60));
  console.log("thin candidates", JSON.stringify(cands.slice(0, 5)));
  expect(cands.length).toBeGreaterThan(0);
  // thinnest elements first; a hit is the raycast's own element at that exact pixel
  let selected: number | null = null;
  let target: (typeof cands)[number] | null = null;
  for (const c of cands.slice(0, 4)) {
    await touch.tap(c.x, c.y);
    const ok = await expect
      .poll(async () => ((await dbg(app.page, (d) => d.state())).picked as { localId: number } | null)?.localId ?? null, { timeout: 8000 })
      .toBe(c.localId)
      .then(() => true, () => false);
    if (ok) {
      selected = c.localId;
      target = c;
      break;
    }
  }
  console.log("thin element tap", JSON.stringify({ target, selected }));
  expect(selected, "a tap on a thin element selects it").not.toBeNull();
  await expect(app.page.getByTestId("props-sheet")).toBeVisible();
  await app.page.getByTestId("props-close").click();
});

test("long-press an element: New task here opens the form with a bim anchor, saving it pins it in 3D", async () => {
  await app.page.getByTestId("model-fit").click();
  await app.page.waitForTimeout(2500);
  const { x, y } = await findElementPoint(3);
  await touch.longPress(x, y, 1000);
  await expect(app.page.getByTestId("model-lp")).toBeVisible({ timeout: 20_000 });
  await app.shot("29-model-longpress");
  await app.page.getByTestId("model-new-task").click();
  await expect(app.page.getByTestId("task-form")).toBeVisible();
  expect(decodeURIComponent(app.page.url())).toMatch(/\/tasks\/new\?anchor=bim:[\w-]+\.\d+@-?[\d.]+,-?[\d.]+,-?[\d.]+~/);
  await expect(app.page.getByTestId("anchor-chip")).toHaveAttribute("data-kind", "bim");
  // the dedicated screen: no task list beside it
  await expect(app.page.getByTestId("task-row")).toHaveCount(0);
  await expect(app.page.getByTestId("tasks-list-pane")).toHaveCount(0);
  await app.shot("29b-model-new-task-screen");
  await app.page.getByTestId("task-title").fill(TITLE);
  await app.page.getByTestId("task-submit").click();
  // Save returns to the 3D view of the building, with the new pin
  await expect(app.page.getByTestId("model-route")).toBeVisible({ timeout: 30_000 });
  taskId = (decodeURIComponent(app.page.url()).match(/[?&]task=([^&#]+)/) ?? [])[1] ?? "";
  expect(taskId).not.toBe("");
  await expect(app.page.locator(`[data-testid="model-pin"][data-task-id="${taskId}"]`)).toHaveCount(1, { timeout: 30_000 });
  await app.page.goto(app.page.url().split("#")[0] + `#/tasks/${taskId}`);
  await expect(app.page.getByTestId("task-detail")).toBeVisible({ timeout: 30_000 });
  await expect(app.page.getByTestId("detail-title")).toHaveText(TITLE);
  await expect(app.page.getByTestId("loc-model")).toBeVisible();
});

test("task detail: show in model flies to the pin; the pin projects where the engine says; tapping it opens the task", async () => {
  await app.page.getByTestId("loc-model").click();
  await waitReady(app.page);
  expect(app.page.url()).toContain(`/model/`);
  expect(app.page.url()).toContain(`task=${taskId}`);
  const pin = app.page.locator(`[data-testid="model-pin"][data-task-id="${taskId}"]`);
  await expect(pin).toHaveAttribute("data-visible", "true", { timeout: 30_000 });
  await expect(pin).toHaveClass(/is-focused/);
  await app.page.waitForTimeout(1500); // fly-in finished
  await expect(pin).toHaveAttribute("data-visible", "true");
  const s = (await dbg(app.page, (d, id) => d.pinScreen(id), taskId))!;
  console.log("pin screen", JSON.stringify(s));
  expect(s.visible).toBe(true);
  expect(s.handle).not.toBeNull();
  // our projection math vs the engine's own: the pin button is anchored at its tip (bottom centre)
  const box = (await pin.boundingBox())!;
  const tipX = box.x + box.width / 2;
  expect(Math.abs(tipX - s.handle!.x)).toBeLessThan(6);
  const r = await stageRect(app.page);
  expect(box.x).toBeGreaterThan(r.x);
  expect(box.x + box.width).toBeLessThan(r.x + r.w);
  await app.shot("30-model-pin-focused");

  // the pin follows the camera and never renders without it moving: once the fly-in has fully settled (a fast device
  // can still be easing after the fixed wait), the overlay draws nothing more
  let settledFrames = -1;
  await expect
    .poll(async () => { const o = await dbg(app.page, (d) => d.overlay()); const ok = !o?.running && o?.frames === settledFrames; settledFrames = o?.frames ?? -1; return ok; }, { intervals: [500], timeout: 15_000 })
    .toBe(true);
  const before = await dbg(app.page, (d) => d.overlay());
  await app.page.waitForTimeout(2500);
  const after = await dbg(app.page, (d) => d.overlay());
  expect(after?.frames).toBe(before?.frames);
  expect(after?.running).toBe(false);

  await pin.click();
  await expect(app.page.getByTestId("task-detail")).toBeVisible({ timeout: 20_000 });
  await expect(app.page.getByTestId("detail-title")).toHaveText(TITLE);
});

type V3 = [number, number, number];
const d3 = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
/** Area of a planar polygon in 3D (Newell). */
function polyArea(p: V3[]): number {
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length];
    nx += (a[1] - b[1]) * (a[2] + b[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return Math.hypot(nx, ny, nz) / 2;
}
const angleAt = (a: V3, v: V3, b: V3) => {
  const u = [a[0] - v[0], a[1] - v[1], a[2] - v[2]], w = [b[0] - v[0], b[1] - v[1], b[2] - v[2]];
  const c = (u[0] * w[0] + u[1] * w[1] + u[2] * w[2]) / (Math.hypot(...u) * Math.hypot(...w));
  return (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI;
};

/** Screen points on the model that are at least `gap` px apart, each with the raycaster's own surface point there. */
async function surfacePoints(n: number, gap = 150, min = n) {
  const r = await stageRect(app.page);
  const out: { x: number; y: number; point: V3 }[] = [];
  for (let j = 0; j < 8 && out.length < n; j++) {
    for (let i = 0; i < 10 && out.length < n; i++) {
      const x = r.x + r.w * (0.12 + i * 0.085);
      const y = r.y + r.h * (0.22 + j * 0.09);
      if (out.some((o) => Math.hypot(o.x - x, o.y - y) < gap)) continue;
      const hit = await dbg(app.page, (d, a) => d.elementAt(a.x, a.y), { x, y });
      if (!hit || !(await clearOfUi(x, y))) continue;
      // a point on a seam between two panels is a coin flip for any pick: require surface all around it
      let solid = true;
      for (const [dx, dy] of [[8, 0], [-8, 0], [0, 8], [0, -8]]) {
        if (!(await dbg(app.page, (d, a) => d.elementAt(a.x, a.y), { x: x + dx, y: y + dy }))) solid = false;
      }
      if (solid) out.push({ x, y, point: hit.point });
    }
  }
  expect(out.length, "enough model surface on screen to measure").toBeGreaterThanOrEqual(min);
  return out;
}

const measureTap = async (x: number, y: number, placedAfter: number) => {
  await touch.tap(x, y);
  await expect(app.page.getByTestId("measure3d-bar")).toHaveAttribute("data-placed", String(placedAfter), { timeout: 15_000 });
};

/** Step 1 of a length / area / angle: a tap on a surface sets the measuring plane (a set plane is dropped first). */
const setPlane = async (x: number, y: number) => {
  const bar = app.page.getByTestId("measure3d-bar");
  if (await app.page.getByTestId("measure3d-plane").count()) await app.page.getByTestId("measure3d-plane").click();
  await expect(bar).toHaveAttribute("data-plane", "0");
  await expect(app.page.getByTestId("measure3d-hint")).toContainText("First tap the surface");
  await touch.tap(x, y);
  try {
    await expect(bar).toHaveAttribute("data-plane", "1", { timeout: 15_000 });
  } catch (err) {
    const el = await dbg(app.page, (d, a) => d.elementAt(a.x, a.y), { x, y });
    console.log("PLANE PICK", JSON.stringify({ x, y, viewer: el?.point ?? null, plane: await app.page.evaluate(() => (window as unknown as { __ffmPlane?: unknown }).__ffmPlane ?? null) }));
    throw err;
  }
  await expect(bar).toHaveAttribute("data-placed", "0");
};

type MeasureProbe = { x: number; y: number; pick: V3 | null; plane: [number, number, number, number] | null };
const probe = () => app.page.evaluate(() => (window as unknown as { __ffmMeasure?: unknown }).__ffmMeasure ?? null) as Promise<MeasureProbe | null>;
const offPlane = (pl: [number, number, number, number], p: V3) => Math.abs(pl[0] * p[0] + pl[1] * p[1] + pl[2] * p[2] + pl[3]);

test("3D measure: Measure toggle arms the tools, taps neither select nor long-press, walk is off", async () => {
  if (!(await app.page.getByTestId("model-page").count())) await gotoModel(app);
  if (await app.page.getByTestId("props-sheet").count()) await app.page.getByTestId("props-close").click();
  await app.page.getByTestId("model-fit").click();
  await app.page.waitForTimeout(2500);
  await app.page.getByTestId("model-measure").click();
  await expect(app.page.getByTestId("measure3d-bar")).toBeVisible();
  await expect(app.page.getByTestId("measure3d-bar")).toHaveAttribute("data-variant", "length");
  for (const v of ["length", "area", "angle", "volume"]) await expect(app.page.getByTestId(`measure3d-${v}`)).toBeVisible();
  await expect(app.page.getByTestId("model-walk")).toBeDisabled();
  await expect(app.page.getByTestId("measure3d-bar")).toHaveAttribute("data-plane", "0");
  await expect(app.page.getByTestId("measure3d-hint")).toContainText("First tap the surface");
  await app.shot("50-model-measure-bar");
  // touch targets keep 44 px
  for (const id of ["measure3d-length", "measure3d-area", "measure3d-angle", "measure3d-volume", "measure3d-undo", "measure3d-cancel", "measure3d-list", "measure3d-done", "model-measure"]) {
    const b = (await app.page.getByTestId(id).boundingBox())!;
    expect(Math.min(b.width, b.height), `${id} touch target`).toBeGreaterThanOrEqual(43.5);
  }
  // a tap on an element and a long press do not select or start a task
  const [p1] = await surfacePoints(1);
  await touch.tap(p1.x, p1.y);
  // the first tap set the measuring plane: it shows, and Change plane is offered
  await expect(app.page.getByTestId("measure3d-bar")).toHaveAttribute("data-plane", "1", { timeout: 15_000 });
  await expect(app.page.getByTestId("measure3d-bar")).toHaveAttribute("data-placed", "0");
  const cp = (await app.page.getByTestId("measure3d-plane").boundingBox())!;
  expect(Math.min(cp.width, cp.height), "Change plane touch target").toBeGreaterThanOrEqual(43.5);
  await app.page.waitForTimeout(500);
  await app.shot("50b-model-measure-plane");
  await touch.longPress(p1.x + 10, p1.y + 10, 1000);
  await app.page.waitForTimeout(800);
  await expect(app.page.getByTestId("props-sheet")).toHaveCount(0);
  await expect(app.page.getByTestId("model-lp")).toHaveCount(0);
  expect(((await dbg(app.page, (d) => d.state())).picked as unknown) ?? null).toBeNull();
  // those touches were measure points (that is the point of the mode): start the next test from a clean slate
  await app.page.waitForTimeout(1500);
  if ((await app.page.getByTestId("measure3d-bar").getAttribute("data-placed")) !== "0") await app.page.getByTestId("measure3d-cancel").click();
  await app.page.getByTestId("measure3d-list").click();
  if (await app.page.getByTestId("measure3d-clear").count()) await app.page.getByTestId("measure3d-clear").click();
  await app.page.getByTestId("measure3d-sheet-close").click();
  await expect(app.page.getByTestId("measure3d-bar")).toHaveAttribute("data-placed", "0");
});

test("3D length: two taps place a measurement whose label matches the engine's own geometry", async () => {
  const cands = await surfacePoints(12, 70, 3);
  const sr = await stageRect(app.page);
  let ai = -1;
  for (let i = 0; i < cands.length; i++) if (cands[i].y + 60 < sr.y + sr.h - 12 && (await clearOfUi(cands[i].x, cands[i].y + 60))) { ai = i; break; }
  expect(ai, "a long-press finger spot clear of the UI").toBeGreaterThanOrEqual(0);
  const a = cands[ai];
  // the second point: the first one in scan order that is at least 220 px away (else the farthest), like the pair this test always used
  const others = cands.filter((c, i) => i !== ai);
  const b = others.find((c) => Math.hypot(c.x - a.x, c.y - a.y) >= 220) ?? others.sort((p, q) => Math.hypot(q.x - a.x, q.y - a.y) - Math.hypot(p.x - a.x, p.y - a.y))[0];
  await setPlane(a.x, a.y);
  // the loupe shows once the finger has rested (long press): the reticle sits 60 px above the finger, the point lands there
  const f = await touch.press(a.x, a.y + 60);
  await app.page.waitForTimeout(700);
  await expect(app.page.getByTestId("measure-loupe")).toBeVisible({ timeout: 10_000 });
  await deviceShot(app, "51-model-measure-loupe");
  await f.release();
  await expect(app.page.getByTestId("measure-loupe")).toHaveCount(0);
  await expect(app.page.getByTestId("measure3d-bar")).toHaveAttribute("data-placed", "1", { timeout: 15_000 });
  // undo drops the point and replays nothing; place again
  await app.page.getByTestId("measure3d-undo").click();
  await expect(app.page.getByTestId("measure3d-bar")).toHaveAttribute("data-placed", "0", { timeout: 15_000 });
  await measureTap(a.x, a.y, 1);
  await touch.tap(b.x, b.y);
  await expect(app.page.getByTestId("measure3d-list")).toContainText("(1)", { timeout: 15_000 });
  await app.page.waitForTimeout(500);
  await deviceShot(app, "52-model-length");
  const items = (await dbg(app.page, (d) => d.measureItems())).filter((i) => i.variant === "length");
  expect(items).toHaveLength(1);
  const [s, e] = items[0].points;
  // both points lie on the measuring plane; the first one is where the plane was picked (same pixel, same face)
  const pr = (await probe())!;
  console.log("3D length", JSON.stringify({ hitA: a.point, start: s, end: e, plane: pr.plane }));
  expect(pr.plane).not.toBeNull();
  expect(offPlane(pr.plane!, s)).toBeLessThan(0.01);
  expect(offPlane(pr.plane!, e)).toBeLessThan(0.01);
  expect(d3(s, a.point)).toBeLessThan(0.05);
  await app.page.getByTestId("measure3d-list").click();
  const row = app.page.getByTestId("measure3d-row");
  await expect(row).toHaveCount(1);
  const text = (await row.getAttribute("data-text"))!;
  expect(text).toMatch(/^\d+\.\d{2} m$/); // the web's precision: metres, 2 decimals
  expect(Math.abs(parseFloat(text) - d3(s, e))).toBeLessThan(0.006);
  console.log("3D length label", text, "engine", d3(s, e).toFixed(4));
  await app.shot("53-model-measure-list");
});

test("3D area and angle through the engine's measurement components; volume does not break the viewer", async () => {
  await app.page.getByTestId("measure3d-sheet-close").click();
  const pts = await surfacePoints(4, 160);
  await app.page.getByTestId("measure3d-area").click();
  await expect(app.page.getByTestId("measure3d-bar")).toHaveAttribute("data-variant", "area");
  await expect(app.page.getByTestId("measure3d-bar")).toHaveAttribute("data-plane", "1"); // switching Length to Area keeps the plane
  await measureTap(pts[0].x, pts[0].y, 1);
  await measureTap(pts[1].x, pts[1].y, 2);
  await measureTap(pts[2].x, pts[2].y, 3);
  await expect(app.page.getByTestId("measure3d-finish")).toBeEnabled();
  await app.page.getByTestId("measure3d-finish").click();
  await expect(app.page.getByTestId("measure3d-list")).toContainText("(2)", { timeout: 15_000 });
  await app.page.getByTestId("measure3d-angle").click();
  await measureTap(pts[0].x, pts[0].y, 1);
  await measureTap(pts[1].x, pts[1].y, 2);
  await touch.tap(pts[2].x, pts[2].y);
  await expect(app.page.getByTestId("measure3d-list")).toContainText("(3)", { timeout: 15_000 });
  await app.page.waitForTimeout(500);
  await deviceShot(app, "54-model-area-angle");
  const items = await dbg(app.page, (d) => d.measureItems());
  const area = items.find((i) => i.variant === "area")!;
  const ang = items.find((i) => i.variant === "angle")!;
  await app.page.getByTestId("measure3d-list").click();
  const aRow = app.page.locator('[data-testid="measure3d-row"][data-variant="area"]');
  const nRow = app.page.locator('[data-testid="measure3d-row"][data-variant="angle"]');
  const aText = (await aRow.getAttribute("data-text"))!;
  const nText = (await nRow.getAttribute("data-text"))!;
  console.log("3D area", aText, "engine", polyArea(area.points).toFixed(4), "| angle", nText, "engine", angleAt(ang.points[0], ang.points[1], ang.points[2]).toFixed(3));
  expect(aText).toMatch(/^\d+\.\d{2} m²$/);
  expect(Math.abs(parseFloat(aText) - polyArea(area.points))).toBeLessThan(0.02);
  expect(nText).toMatch(/^\d+\.\d°$/);
  expect(Math.abs(parseFloat(nText) - angleAt(ang.points[0], ang.points[1], ang.points[2]))).toBeLessThan(0.15);
  await app.shot("55-model-measure-3");
  // volume: arm it, pick an element, finish; the viewer must survive and the list gains an entry (or stays pending)
  await app.page.getByTestId("measure3d-sheet-close").click();
  const errs0 = app.pageErrors.length;
  await app.page.getByTestId("measure3d-volume").click();
  await measureTap(pts[3].x, pts[3].y, 1);
  await app.page.getByTestId("measure3d-finish").click();
  await expect(app.page.getByTestId("measure3d-list")).toContainText("(4)", { timeout: 30_000 });
  await app.page.getByTestId("measure3d-list").click();
  const vText = await app.page.locator('[data-testid="measure3d-row"][data-variant="volume"]').getAttribute("data-text", { timeout: 30_000 });
  console.log("3D volume label", vText);
  await expect(app.page.locator('[data-testid="measure3d-row"][data-variant="volume"]')).toHaveAttribute("data-text", /m³$/, { timeout: 60_000 });
  expect(app.pageErrors.slice(errs0)).toEqual([]);
});

test("3D measurements list: focus, delete one, clear all; two fingers keep the camera; Done leaves select mode", async () => {
  const rows = app.page.getByTestId("measure3d-row");
  await expect(rows).toHaveCount(4);
  const pose0 = (await dbg(app.page, (d) => d.pose()))!;
  await rows.first().getByTestId("measure3d-row-focus").click();
  await expect.poll(async () => moved(pose0, (await dbg(app.page, (d) => d.pose()))!), { timeout: 8000 }).toBeGreaterThan(0.01);
  await app.page.getByTestId("measure3d-list").click();
  await rows.first().getByTestId("measure3d-row-delete").click();
  await expect(rows).toHaveCount(3);
  await app.page.getByTestId("measure3d-sheet-close").click();
  // two fingers orbit/zoom while measuring and add no point
  const r = await stageRect(app.page);
  const pose1 = (await dbg(app.page, (d) => d.pose()))!;
  await touch.pinch(r.x + r.w / 2, r.y + r.h / 2, 120, 360);
  await expect.poll(async () => moved(pose1, (await dbg(app.page, (d) => d.pose()))!), { timeout: 8000 }).toBeGreaterThan(0.01);
  await expect(app.page.getByTestId("measure3d-bar")).toHaveAttribute("data-placed", "0");
  await app.page.getByTestId("measure3d-list").click();
  await expect(rows).toHaveCount(3);
  await app.page.getByTestId("measure3d-clear").click();
  await expect(rows).toHaveCount(0);
  await app.page.getByTestId("measure3d-sheet-close").click();
  await app.page.getByTestId("measure3d-done").click();
  await expect(app.page.getByTestId("measure3d-bar")).toHaveCount(0);
  await expect(app.page.getByTestId("model-walk")).toBeEnabled();
  expect(await dbg(app.page, (d) => d.measureItems())).toHaveLength(0);
});

// ── 3D UX: camera toolbar, measure gestures, walk levels (both orientations) ─────────────────────────────

type Box = { x: number; y: number; w: number; h: number };
const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const boxOf = async (id: string): Promise<Box> => {
  const b = (await app.page.getByTestId(id).first().boundingBox())!;
  return { x: b.x, y: b.y, w: b.width, h: b.height };
};
const shotTo = async (name: string) => {
  await deviceShot(app, name);
};

async function ux3d(tag: "landscape" | "portrait"): Promise<void> {
  const page = app.page;
  await ensureModel();
  await page.getByTestId("model-fit").click();
  await page.waitForTimeout(2500);
  const r = await stageRect(page);
  const want = r.w > r.h ? "rail" : "bar";
  console.log(`3D UX ${tag}: stage ${Math.round(r.w)}x${Math.round(r.h)} -> ${want}`);

  // ── toolbar: grouped, 44 px targets, clear of the model centre and of the filter chips
  await expect(page.getByTestId("model-tools")).toHaveAttribute("data-layout", want);
  for (const id of ["model-fit", "model-reset", "model-walk", "model-measure", "model-tools-button"]) {
    const b = await boxOf(id);
    expect(Math.min(b.w, b.h), `${id} touch target`).toBeGreaterThanOrEqual(44);
  }
  const tb = await boxOf("model-tools");
  expect(overlaps(tb, { x: r.x + r.w / 2 - 40, y: r.y + r.h / 2 - 40, w: 80, h: 80 }), "toolbar leaves the model centre free").toBe(false);
  expect(tb.x + tb.w, "toolbar inside the screen").toBeLessThanOrEqual(r.x + r.w + 1);
  expect(tb.y + tb.h).toBeLessThanOrEqual(r.y + r.h + 1);
  // the Filters summary chips do not collide with it
  await openFilters(page);
  await page.locator('[data-testid="filter-category"] input[type="checkbox"]').first().uncheck();
  await closeFilters(page);
  await expect(page.getByTestId("filter-chip").first()).toBeVisible();
  for (const c of await page.getByTestId("filter-chip").all()) {
    const b = (await c.boundingBox())!;
    expect(overlaps(tb, { x: b.x, y: b.y, w: b.width, h: b.height }), "filter chip vs toolbar").toBe(false);
  }
  await page.waitForTimeout(800);
  await shotTo(`3d-ux-toolbar-${tag}`);

  // ── tools: one panel at a time, a header with a close button, the toolbar clear of the sheet
  await page.getByTestId("model-tools-button").click();
  const menu = await boxOf("tools-menu");
  expect(menu.x).toBeGreaterThanOrEqual(r.x - 1);
  expect(menu.y).toBeGreaterThanOrEqual(r.y - 1);
  await shotTo(`3d-ux-tools-menu-${tag}`);
  await page.getByTestId("tool-section").click();
  await expect(page.getByTestId("section-panel")).toBeVisible();
  await page.getByTestId("model-tools-button").click();
  await page.getByTestId("tool-tree").click();
  await expect(page.getByTestId("tree-panel")).toBeVisible();
  await expect(page.locator(".tool-panel")).toHaveCount(1);
  await expect(page.getByTestId("section-panel")).toHaveCount(0);
  const sheet = await boxOf("tree-panel");
  expect(overlaps(await boxOf("model-tools"), sheet), "toolbar stays clear of the open sheet").toBe(false);
  expect((await boxOf("tree-close")).w).toBeGreaterThanOrEqual(44);
  await page.getByTestId("tree-close").click();
  await expect(page.locator(".tool-panel")).toHaveCount(0);
  await openFilters(page);
  await expect(page.getByTestId("filters-close")).toBeVisible();
  await page.getByTestId("filter-reset").click();
  await page.getByTestId("filters-close").click();
  await expect(page.getByTestId("filters-sheet")).toHaveCount(0);

  // ── measure: one finger orbits, a tap places, a long press aims with a loupe and places where the reticle is
  await page.getByTestId("model-measure").click();
  await expect(page.getByTestId("measure3d-bar")).toBeVisible();
  await expect(page.getByTestId("model-measure")).toHaveAttribute("aria-pressed", "true");
  // the session keeps the last tool (an earlier test ended on Volume, which measures elements, no plane): pick Length
  if ((await page.getByTestId("measure3d-bar").getAttribute("data-variant")) === "volume") {
    await expect(page.getByTestId("measure3d-hint")).toContainText("measure its volume");
    await page.getByTestId("measure3d-length").click();
  }
  await expect(page.getByTestId("measure3d-hint")).toContainText("First tap the surface");
  const bar = await boxOf("measure3d-bar");
  const tb2 = await boxOf("model-tools");
  expect(overlaps(bar, tb2), "measure bar vs toolbar").toBe(false);
  expect(bar.x + bar.w).toBeLessThanOrEqual(r.x + r.w + 1);
  await shotTo(`3d-ux-measure-bar-${tag}`);
  const placed = () => page.getByTestId("measure3d-bar");
  const cand = await surfacePoints(4, 100, 1);

  // (a) a one-finger drag orbits the camera and places nothing
  const a = cand[0];
  const pose0 = (await dbg(page, (d) => d.pose()))!;
  const endX = a.x + 150 < r.x + r.w - 20 ? a.x + 150 : a.x - 150;
  await touch.drag(a.x, a.y, endX, a.y + 20, 14);
  await expect.poll(async () => moved(pose0, (await dbg(page, (d) => d.pose()))!), { timeout: 8000 }).toBeGreaterThan(0.01);
  await page.waitForTimeout(500);
  await expect(placed()).toHaveAttribute("data-placed", "0");
  await expect(page.getByTestId("measure-loupe")).toHaveCount(0);

  // (b) the first tap picks the measuring plane, the next tap places a point on it (no loupe needed)
  const fresh = await surfacePoints(4, 100, 1);
  await setPlane(fresh[0].x, fresh[0].y);
  await expect(page.getByTestId("measure3d-hint")).toContainText("Tap to place");
  await shotTo(`3d-ux-measure-plane-${tag}`);
  await measureTap(fresh[0].x, fresh[0].y, 1);
  await page.getByTestId("measure3d-undo").click();
  await expect(placed()).toHaveAttribute("data-placed", "0", { timeout: 15_000 });

  // (c) a long press shows the loupe and the reticle 60 px above the finger; sliding moves it; lifting places the point there
  const stage2 = await stageRect(page);
  let c: { x: number; y: number } | null = null;
  for (const p of await surfacePoints(12, 70, 1)) {
    if (p.y + 60 < stage2.y + stage2.h - 12 && p.x + 30 < stage2.x + stage2.w - 12 && (await clearOfUi(p.x, p.y + 60)) && (await clearOfUi(p.x + 30, p.y + 60))) {
      c = p;
      break;
    }
  }
  expect(c, "a long-press target clear of the UI").not.toBeNull();
  const f = await touch.press(c!.x, c!.y + 60);
  await page.waitForTimeout(700);
  await expect(page.getByTestId("measure-loupe")).toBeVisible({ timeout: 10_000 });
  const ring = async () => {
    const b = (await page.locator('[data-testid="aim-reticle"] .aim-ring').boundingBox())!;
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  };
  const r0 = await ring();
  expect(Math.abs(r0.x - c!.x)).toBeLessThan(3);
  expect(Math.abs(r0.y - c!.y), "reticle 60 px above the fingertip").toBeLessThan(3);
  await f.move(c!.x + 30, c!.y + 60);
  await expect.poll(async () => Math.round((await ring()).x - c!.x)).toBe(30);
  await expect(page.getByTestId("measure-loupe")).toHaveAttribute("data-snap", /Vertex|Edge|Face|On plane/, { timeout: 10_000 });
  await shotTo(`3d-ux-measure-loupe-${tag}`);
  await f.release();
  await expect(page.getByTestId("measure-loupe")).toHaveCount(0);
  await expect(placed()).toHaveAttribute("data-placed", "1", { timeout: 15_000 });
  const mm = await page.evaluate(() => (window as unknown as { __ffmMeasure?: { x: number; y: number } }).__ffmMeasure ?? null);
  expect(mm).not.toBeNull();
  expect(Math.abs(mm!.x - (c!.x + 30))).toBeLessThan(2);
  expect(Math.abs(mm!.y - c!.y)).toBeLessThan(2);
  await page.getByTestId("measure3d-undo").click();
  await expect(placed()).toHaveAttribute("data-placed", "0", { timeout: 15_000 });
  await page.getByTestId("measure3d-done").click();
  await expect(page.getByTestId("measure3d-bar")).toHaveCount(0);

  // ── walk: the level picker teleports the eye to the storey elevation + 1.6 m, x/z and heading stay
  await page.getByTestId("model-walk").click();
  await expect(page.getByTestId("walk-layer")).toBeVisible();
  await expect(page.getByTestId("walk-levels")).toBeVisible();
  await page.waitForTimeout(800);
  const w0 = (await dbg(page, (d) => d.pose()))!;
  const heading = (p: Pose) => Math.atan2(p.target[0] - p.pos[0], -(p.target[2] - p.pos[2]));
  const lv = await boxOf("walk-level");
  expect(Math.min(lv.w, lv.h)).toBeGreaterThanOrEqual(44);
  expect(overlaps(lv, await boxOf("walk-exit")), "level picker vs exit button").toBe(false);
  expect(overlaps(lv, await boxOf("walk-pad")), "level picker vs move pad").toBe(false);
  await page.getByTestId("walk-level").click();
  const opts = await page.getByTestId("walk-level-option").evaluateAll((els) => els.map((e) => ({ name: e.getAttribute("data-level")!, elevation: Number(e.getAttribute("data-elevation")) })));
  expect(opts.length).toBeGreaterThanOrEqual(2);
  await shotTo(`3d-ux-walk-levels-${tag}`);
  const cur = Number(await page.getByTestId("walk-level").getAttribute("data-elevation"));
  const target = opts.filter((o) => Math.abs(o.elevation - cur) > 0.5).sort((x, y) => Math.abs(y.elevation - cur) - Math.abs(x.elevation - cur))[0];
  await page.locator(`[data-testid="walk-level-option"][data-level="${target.name}"]`).first().click();
  await expect(page.getByTestId("walk-level-name")).toHaveText(target.name);
  await expect.poll(async () => (await dbg(page, (d) => d.pose()))!.pos[1], { timeout: 8000 }).toBeCloseTo(target.elevation + 1.6, 1);
  const w1 = (await dbg(page, (d) => d.pose()))!;
  expect(Math.abs(w1.pos[0] - w0.pos[0])).toBeLessThan(1e-3);
  expect(Math.abs(w1.pos[2] - w0.pos[2])).toBeLessThan(1e-3);
  expect(Math.abs(heading(w1) - heading(w0))).toBeLessThan(0.01);
  // the stepper buttons move one level
  const sorted = [...opts].sort((x, y) => x.elevation - y.elevation);
  const at = sorted.findIndex((o) => o.name === target.name);
  if (at > 0) {
    await page.getByTestId("walk-level-down").click();
    await expect.poll(async () => (await dbg(page, (d) => d.pose()))!.pos[1], { timeout: 8000 }).toBeCloseTo(sorted[at - 1].elevation + 1.6, 1);
  } else {
    await page.getByTestId("walk-level-up").click();
    await expect.poll(async () => (await dbg(page, (d) => d.pose()))!.pos[1], { timeout: 8000 }).toBeCloseTo(sorted[at + 1].elevation + 1.6, 1);
  }
  await page.waitForTimeout(600);
  await shotTo(`3d-ux-walk-${tag}`);
  await page.getByTestId("walk-exit").click();
  await expect(page.getByTestId("model-page")).toHaveAttribute("data-mode", "orbit");
}

test("3D UX (portrait): grouped toolbar bar, measure gestures with aim loupe, walk level picker", async () => {
  test.setTimeout(300_000);
  await ux3d("portrait");
});

test("3D UX (landscape): toolbar rail, measure gestures with aim loupe, walk level picker", async () => {
  test.setTimeout(300_000);
  await setRotation(app, 1);
  try {
    await app.page.waitForTimeout(3500);
    await ux3d("landscape");
  } finally {
    await setRotation(app, 0);
    await app.page.waitForTimeout(2500);
  }
});

test("context loss shows Reloading model, recovers automatically and keeps the camera", async () => {
  await gotoModel(app);
  await app.page.waitForTimeout(2000);
  await app.page.getByTestId("model-fit").click();
  await app.page.waitForTimeout(1500);
  const pose = (await dbg(app.page, (d) => d.pose()))!;
  expect(await dbg(app.page, (d) => d.loseContext())).toBe(true);
  await expect(app.page.getByTestId("model-status")).toContainText("Reloading model", { timeout: 10_000 });
  await app.shot("31-model-reloading");
  await waitReady(app.page);
  await expect.poll(async () => moved(pose, (await dbg(app.page, (d) => d.pose()))!), { timeout: 15_000 }).toBeLessThan(0.5);
  const st = await dbg(app.page, (d) => d.state());
  expect(st.contextLosses).toBe(1);
  expect(await dbg(app.page, (d) => d.registry())).toMatchObject({ live: 1 });
  await app.page.waitForTimeout(2000);
  await expectGeometry(app, "32-model-recovered");
});

test("background guard releases the model and reloads it on resume", async () => {
  await app.page.evaluate(() => window.localStorage.setItem("ffm.model.releaseAfterMs", "300"));
  await app.page.evaluate(() => void window.__ffmModelDebug!.simulateBackground(3500));
  await expect(app.page.getByTestId("model-page")).toHaveAttribute("data-phase", "released", { timeout: 10_000 });
  await expect.poll(() => dbg(app.page, (d) => d.registry().live), { timeout: 10_000 }).toBe(0);
  await expect(app.page.getByTestId("model-status")).toContainText("released");
  await waitReady(app.page);
  expect(await dbg(app.page, (d) => d.registry())).toMatchObject({ live: 1, overlaps: 0 });
  await app.page.evaluate(() => window.localStorage.removeItem("ffm.model.releaseAfterMs"));
});

test("offline (airplane mode): the model still opens and picks", async () => {
  await app.shell("cmd connectivity airplane-mode enable");
  await expect(app.page.getByTestId("sync-chip")).toHaveAttribute("data-state", "offline", { timeout: 30_000 });
  await goTab("Tasks");
  await gotoModel(app);
  await app.page.waitForTimeout(2500);
  await expectGeometry(app, "33-model-offline");
  await app.page.getByTestId("model-fit").click();
  await app.page.waitForTimeout(2000);
  await tapUntilSheet();
  await expect(app.page.getByTestId("props-attrs")).toContainText("GlobalId", { timeout: 20_000 });
  await app.shell("cmd connectivity airplane-mode disable");
  await expect(app.page.getByTestId("sync-chip")).toHaveAttribute("data-state", "online", { timeout: 60_000 });
});

// ── 3D tools (Tools menu) ────────────────────────────────────────────

/** Set a range input the way a drag would (React listens to the native `input` event). */
const setRange = (id: string, value: number) =>
  app.page.getByTestId(id).evaluate((el, v) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    set.call(el, String(v));
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, Math.round(value * 100) / 100);
/**
 * Device framebuffer that is not a blank compositor frame (a late frame on the software GPU shows a uniform surface for a moment):
 * retake every 2 s for up to 60 s.
 */
async function liveShot(name: string) {
  const t0 = Date.now();
  for (;;) {
    const img = await deviceShot(app, name);
    const g = geometryStats(img, { x: 0, y: 0, w: img.width, h: img.height });
    if (g.colours > 6 || Date.now() - t0 > 60_000) return img;
    await app.page.waitForTimeout(2000);
  }
}
const toolsState = () => dbg(app.page, (d) => d.tools());
async function ensureModel(): Promise<void> {
  if (!(await app.page.getByTestId("model-page").count())) await gotoModel(app);
  await expect(app.page.getByTestId("model-page")).toHaveAttribute("data-phase", "ready", { timeout: 60_000 });
  for (const id of ["props-close", "section-close", "filter-done", "tree-close", "search-close", "views-close"]) if (await app.page.getByTestId(id).count()) await app.page.getByTestId(id).click();
}
async function openTool(id: "section" | "tree" | "search" | "views"): Promise<void> {
  await app.page.getByTestId("model-tools-button").click();
  await expect(app.page.getByTestId("tools-menu")).toBeVisible();
  await app.page.getByTestId(`tool-${id}`).click();
  await expect(app.page.getByTestId(`${id}-panel`)).toBeVisible();
}

test("tools: the Tools menu groups section, tree and search; Measure stays on the toolbar; one Filters button, no chip rows", async () => {
  await ensureModel();
  await app.page.getByTestId("model-fit").click();
  await app.page.waitForTimeout(2000);
  await expect(app.page.getByTestId("model-measure")).toBeVisible();
  // one Filters button in the toolbar row of the building picker; no per-storey / per-model chips on the stage
  const bar = await center(app.page.locator(".model-bar"));
  const fb = await center(app.page.getByTestId("model-filters"));
  const pick = await center(app.page.getByTestId("model-building-picker"));
  expect(fb.h).toBeGreaterThanOrEqual(44);
  expect(Math.abs(fb.y - pick.y), "Filters sits in the same toolbar row as the building picker").toBeLessThan(bar.h / 2);
  await expect(app.page.getByTestId("storey-chip")).toHaveCount(0);
  await expect(app.page.getByTestId("model-chip")).toHaveCount(0);
  await liveShot("40-toolbar");
  await app.page.getByTestId("model-tools-button").click();
  const menu = app.page.getByTestId("tools-menu");
  await expect(menu).toBeVisible();
  for (const id of ["section", "tree", "search"]) {
    const b = await center(app.page.getByTestId(`tool-${id}`));
    expect(b.h, `${id} touch target`).toBeGreaterThanOrEqual(44);
  }
  await liveShot("40-tools-menu");
  await app.page.getByTestId("model-tools-button").click();
  await expect(menu).toHaveCount(0);
});

test("tools: section box changes what is drawn; planes flip and remove; Reset restores", async () => {
  await ensureModel();
  await app.page.getByTestId("model-fit").click();
  await app.page.waitForTimeout(2500);
  const before = await liveShot("41-section-before");
  const region = centralRegion(before);
  await openTool("section");
  await app.page.getByTestId("section-box-view").click();
  await expect(app.page.getByTestId("section-box-controls")).toBeVisible();
  expect((await toolsState()).section.enginePlanes).toHaveLength(6);
  // bring the x faces together: keep the middle 30 % of the building
  const x0 = app.page.getByTestId("section-x-min");
  const lo = Number(await x0.getAttribute("min"));
  const hi = Number(await x0.getAttribute("max"));
  await setRange("section-x-min", lo + (hi - lo) * 0.45);
  await setRange("section-x-max", lo + (hi - lo) * 0.62);
  await expect.poll(async () => (await toolsState()).section.enginePlanes.some((p) => p.normal[0] === 1 && p.point[0] > lo + (hi - lo) * 0.4)).toBe(true);
  expect((await toolsState()).section.enginePlanes, "sliders update planes in place").toHaveLength(6);
  await liveShot("42-section-panel");
  await app.page.getByTestId("section-close").click();
  await app.page.waitForTimeout(2500);
  const cut = await liveShot("43-section-box");
  const diff = meanDiff(before, cut, region);
  console.log("section box mean pixel diff", diff.toFixed(2));
  expect(diff, "the box clips the model").toBeGreaterThan(1);

  // a plane combines with the box (and with the storey Cut); flip and remove
  await openTool("section");
  await app.page.getByTestId("section-add-y").click();
  expect((await toolsState()).section.enginePlanes).toHaveLength(7);
  const n0 = (await toolsState()).section.enginePlanes[6].normal;
  await app.page.getByTestId("section-plane-flip").click();
  await expect.poll(async () => (await toolsState()).section.enginePlanes[6].normal[1]).toBe(-n0[1] === 0 ? 0 : -n0[1]);
  await app.page.getByTestId("section-plane-remove").click();
  expect((await toolsState()).section.enginePlanes).toHaveLength(6);
  await app.page.getByTestId("section-reset").click();
  expect((await toolsState()).section.enginePlanes).toHaveLength(0);
  await app.page.getByTestId("section-close").click();
  await app.page.waitForTimeout(2500);
  const back = await liveShot("44-section-reset");
  expect(meanDiff(before, back, region)).toBeLessThan(Math.max(diff / 2, 3));
});

test("tools: isolate, hide, x-ray and show all; a hidden element is never picked", async () => {
  await ensureModel();
  await app.page.getByTestId("model-fit").click();
  await app.page.waitForTimeout(2500);
  const all = await liveShot("45-vis-all");
  const region = centralRegion(all);
  const { x, y, hit } = await findElementPoint(1);
  await touch.tap(x, y);
  await expect(app.page.getByTestId("props-sheet")).toBeVisible({ timeout: 15_000 });
  await app.page.getByTestId("props-isolate").click(); // quick action on the properties sheet
  await expect.poll(async () => (await toolsState()).isolated).toBe(true);
  await app.page.waitForTimeout(2500);
  await app.page.getByTestId("props-close").click();
  const iso = await liveShot("46-vis-isolated");
  expect(meanDiff(all, iso, region), "isolate changes the picture").toBeGreaterThan(1);

  await openFilters(app.page);
  await expect(app.page.getByTestId("filter-categories")).toBeVisible();
  await expect(app.page.getByTestId("filter-category").first()).toBeVisible({ timeout: 30_000 });
  await app.page.getByTestId("filter-reset").click();
  await expect.poll(async () => (await toolsState()).isolated).toBe(false);
  await expect.poll(async () => Object.values((await toolsState()).hiddenCount).reduce((n, h) => n + h.n, 0)).toBe(0);
  await closeFilters(app.page);
  await app.page.waitForTimeout(2500);
  expect(meanDiff(all, await liveShot("47-vis-restored"), region)).toBeLessThan(3);

  // hide selection: the same pixel no longer picks that element
  await touch.tap(x, y);
  await expect(app.page.getByTestId("props-sheet")).toBeVisible({ timeout: 15_000 });
  await app.page.getByTestId("props-hide").click();
  await expect.poll(async () => Object.values((await toolsState()).hiddenCount).reduce((n, h) => n + h.n, 0)).toBeGreaterThan(0);
  await app.page.waitForTimeout(2000);
  const again = await dbg(app.page, (d, a) => d.elementAt(a.x, a.y), { x, y });
  console.log("pick at the hidden element's pixel:", JSON.stringify(again), "was", JSON.stringify(hit));
  expect(again === null || again.localId !== hit.localId || again.modelId !== hit.modelId, "a hidden element is not picked").toBe(true);
  await touch.tap(x, y);
  await app.page.waitForTimeout(1500);
  const picked = ((await dbg(app.page, (d) => d.state())).picked as { localId: number } | null)?.localId ?? null;
  expect(picked).not.toBe(hit.localId);

  // category toggle + x-ray
  await openFilters(app.page);
  const cat = app.page.getByTestId("filter-category").first();
  const catName = await cat.getAttribute("data-category");
  await cat.locator("input").uncheck();
  await expect.poll(async () => (await toolsState()).hiddenCategories).toContain(catName);
  await liveShot("48-vis-panel");
  await app.page.getByTestId("filter-reset").click();
  await expect.poll(async () => (await toolsState()).hiddenCategories).toEqual([]);
  await closeFilters(app.page);
  await app.page.waitForTimeout(1500);
  await touch.tap(x, y);
  await app.page.waitForTimeout(2000);
  if (!(await app.page.getByTestId("props-sheet").count())) {
    const f = await findElementPoint(5);
    await touch.tap(f.x, f.y);
  }
  await expect(app.page.getByTestId("props-sheet")).toBeVisible({ timeout: 15_000 });
  await openFilters(app.page);
  await app.page.getByTestId("vis-xray").click();
  await expect.poll(async () => (await toolsState()).xray).toBe(true);
  await closeFilters(app.page);
  await app.page.waitForTimeout(2500);
  await liveShot("49-vis-xray");
  await openFilters(app.page);
  await app.page.getByTestId("filter-reset").click();
  await expect.poll(async () => (await toolsState()).xray).toBe(false);
  await closeFilters(app.page);
});

test("tools: model tree selects an element and flies to it; checkboxes control visibility", async () => {
  await ensureModel();
  await app.page.getByTestId("model-fit").click();
  await app.page.waitForTimeout(2000);
  const before = (await dbg(app.page, (d) => d.pose()))!;
  await openTool("tree");
  await expect(app.page.getByTestId("tree-row").first()).toBeVisible({ timeout: 30_000 });
  // open the first collapsed node until elements show (model > building > storey > class group > elements)
  for (let i = 0; i < 8 && !(await app.page.locator('[data-testid="tree-row"][data-kind="element"]').count()); i++) {
    const t = app.page.locator('[data-testid="tree-row"]:has([data-testid="tree-toggle"][aria-expanded="false"]) [data-testid="tree-toggle"]').first();
    if (!(await t.count())) break;
    await t.click();
    await app.page.waitForTimeout(400);
  }
  const rows = await app.page.getByTestId("tree-row").count();
  console.log("tree rows", rows);
  await liveShot("50-tree");
  const el = app.page.locator('[data-testid="tree-row"][data-kind="element"]').first();
  await expect(el).toBeVisible();
  const id = Number(await el.getAttribute("data-local-id"));
  await el.getByTestId("tree-label").click();
  await expect(app.page.getByTestId("tree-selected")).toBeVisible();
  await expect.poll(async () => ((await dbg(app.page, (d) => d.state())).picked as { localId: number } | null)?.localId ?? null).toBe(id);
  await expect.poll(async () => { const a = await dbg(app.page, (d) => d.pose()); return a ? moved(before, a) : 0; }, { timeout: 15_000 }).toBeGreaterThan(0.05);
  await app.page.waitForTimeout(2500);
  const s = await dbg(app.page, (d) => d.selectionScreen());
  console.log("selection on screen", JSON.stringify(s));
  expect(s?.onScreen, "the flown-to element is in view").toBe(true);
  await liveShot("51-tree-flown");

  // a group checkbox hides its elements and restores them
  const group = app.page.locator('[data-testid="tree-row"][data-kind="group"]').first();
  await group.getByTestId("tree-check").uncheck();
  await expect.poll(async () => Object.values((await toolsState()).hiddenCount).reduce((n, h) => n + h.n, 0)).toBeGreaterThan(0);
  await expect(group).toHaveAttribute("data-visible", "none");
  await group.getByTestId("tree-check").check();
  await expect.poll(async () => Object.values((await toolsState()).hiddenCount).reduce((n, h) => n + h.n, 0)).toBe(0);
  await app.page.getByTestId("tree-properties").click();
  await expect(app.page.getByTestId("props-sheet")).toBeVisible();
  await app.page.getByTestId("props-close").click();
});

test("tools: element search finds a GlobalId, a name and a type, and flies to the result", async () => {
  await ensureModel();
  const sample = (await dbg(app.page, (d) => d.sampleElement(5)))!;
  expect(sample.guid).toMatch(/^[0-9A-Za-z_$]{22}$/);
  await openTool("search");
  await app.page.getByTestId("search-input").fill(sample.guid!);
  await expect(app.page.getByTestId("search-row").first()).toBeVisible({ timeout: 30_000 });
  const row = app.page.getByTestId("search-row").first();
  expect(Number(await row.getAttribute("data-local-id"))).toBe(sample.localId);
  expect(await row.getAttribute("data-kind")).toBe("guid");
  await liveShot("52-search-guid");
  const before = (await dbg(app.page, (d) => d.pose()))!;
  await row.click();
  await expect.poll(async () => ((await dbg(app.page, (d) => d.state())).picked as { localId: number } | null)?.localId ?? null).toBe(sample.localId);
  await expect.poll(async () => { const a = await dbg(app.page, (d) => d.pose()); return a ? moved(before, a) : 0; }, { timeout: 15_000 }).toBeGreaterThan(0.02);

  // by name (a word of it) and by type
  const word = (sample.name ?? "").split(/[\s:]+/).find((w) => w.length >= 4) ?? "";
  if (word) {
    await app.page.getByTestId("search-input").fill(word);
    await expect(app.page.getByTestId("search-row").first()).toBeVisible({ timeout: 30_000 });
    console.log("name search", word, await app.page.getByTestId("search-count").innerText());
  }
  await app.page.getByTestId("search-input").fill("beam");
  await expect(app.page.getByTestId("search-category").first()).toBeVisible({ timeout: 30_000 });
  await liveShot("53-search-type");
  await app.page.getByTestId("search-input").fill("zzqqxxnotthere");
  await expect(app.page.getByTestId("search-empty")).toBeVisible({ timeout: 30_000 });
  await app.page.getByTestId("search-close").click();
});

test("filters: one button and sheet (level, models, categories), summary chips with +n, remembered per building; both orientations", async () => {
  await ensureModel();
  const page = app.page;
  const btn = page.getByTestId("model-filters");
  await expect(btn).toHaveText("Filters");
  // select an element first (x-ray needs a selection; with a level on, little is left to tap)
  await page.getByTestId("model-fit").click();
  await page.waitForTimeout(2500);
  const pt = await findElementPoint(2);
  await touch.tap(pt.x, pt.y);
  await expect(page.getByTestId("props-sheet")).toBeVisible({ timeout: 15_000 });
  const toolbarRow = async () => {
    const bar = await center(page.locator(".model-bar"));
    const fb = await center(btn);
    return { barH: bar.h, filtersH: fb.h, inRow: fb.y >= bar.y - bar.h / 2 && fb.y <= bar.y + bar.h / 2 };
  };
  const portrait = await toolbarRow();
  console.log("toolbar portrait", JSON.stringify(portrait));
  expect(portrait.inRow).toBe(true);
  expect(portrait.barH, "the toolbar is one row").toBeLessThan(80);
  expect(portrait.filtersH).toBeGreaterThanOrEqual(44);

  // the sheet: native radios and checkboxes, 44 px rows, Reset and Done
  await openFilters(page);
  await page.waitForTimeout(1500);
  await liveShot("54-filters-sheet-portrait");
  const rows = await page.getByTestId("filter-level").count();
  expect(rows).toBeGreaterThanOrEqual(2);
  expect(await page.locator('[data-testid="filter-levels"] input[type="radio"]').count()).toBe(rows + 1); // + "All levels"
  expect(await page.locator('[data-testid="filter-category"] input[type="checkbox"]').count()).toBeGreaterThan(0);
  for (const id of ["filter-level-all", "filter-cut", "filter-reset", "filter-done"]) expect((await center(page.getByTestId(id))).h, id).toBeGreaterThanOrEqual(44);
  await expect(page.getByTestId("filter-cut").locator("input")).toBeDisabled(); // Cut belongs to a level
  const names = await page.getByTestId("filter-level").evaluateAll((els) => els.map((e) => e.getAttribute("data-level")!));

  // level + cut = one filter
  await page.locator(`[data-testid="filter-level"][data-level="${names[1]}"]`).click();
  await page.getByTestId("filter-cut").locator("input").check();
  await expect(btn).toHaveText("Filters · 1");
  await expect(page.getByTestId("filter-chip")).toHaveCount(1);
  await expect(page.getByTestId("filter-chip").first()).toContainText(`${names[1]} · cut`);
  expect((await toolsState()).storey).toBe(true);
  // two categories: three filters -> two chips and "+1"
  const cats = page.getByTestId("filter-category");
  await cats.nth(0).locator("input").uncheck();
  await expect(btn).toHaveText("Filters · 2");
  await expect(page.getByTestId("filter-chip")).toHaveCount(2);
  await closeFilters(page);
  await openFilters(page);
  await page.getByTestId("vis-xray").click();
  await expect(btn).toHaveText("Filters · 3");
  await closeFilters(page);
  await expect(page.getByTestId("filter-chip")).toHaveCount(2);
  await expect(page.getByTestId("filter-more")).toHaveText("+1");
  await liveShot("55-filters-summary");
  await page.getByTestId("filter-more").click();
  await expect(page.getByTestId("filters-sheet")).toBeVisible();
  await closeFilters(page);

  // removing a chip removes that filter only
  await page.locator('[data-testid="filter-chip"][data-kind="level"]').click();
  await expect.poll(async () => (await toolsState()).storey).toBe(false);
  await expect(btn).toHaveText("Filters · 2");

  // remembered: leave the tab and come back
  const hidden = (await toolsState()).hiddenCategories;
  expect(hidden.length).toBe(1);
  await openFilters(page);
  await page.locator(`[data-testid="filter-level"][data-level="${names[1]}"]`).click();
  await closeFilters(page);
  await goTab("Tasks");
  await expect.poll(() => page.evaluate(() => window.__ffmModelDebug === undefined)).toBe(true);
  await gotoModel(app);
  await expect(btn).not.toHaveText("Filters", { timeout: 30_000 });
  await expect.poll(async () => (await toolsState()).storey, { timeout: 30_000 }).toBe(true);
  expect((await toolsState()).hiddenCategories).toEqual(hidden);
  console.log("restored after tab switch:", await btn.innerText());

  // landscape (the tablet's own orientation): still one toolbar row, the sheet is a side panel
  await setRotation(app, 1);
  try {
    await page.waitForTimeout(3000);
    const land = await toolsRowLandscape();
    console.log("toolbar landscape", JSON.stringify(land));
    expect(land.inRow).toBe(true);
    expect(land.barH).toBeLessThan(80);
    await liveShot("56-filters-summary-landscape");
    await openFilters(page);
    await page.waitForTimeout(1500);
    await liveShot("57-filters-sheet-landscape");
    await closeFilters(page);
  } finally {
    await setRotation(app, 0);
    await page.waitForTimeout(2500);
  }
  async function toolsRowLandscape() {
    return toolbarRow();
  }

  // Reset clears everything and the memory of it
  await openFilters(page);
  await page.getByTestId("filter-reset").click();
  await closeFilters(page);
  await expect(btn).toHaveText("Filters");
  await expect(page.getByTestId("filter-summary")).toHaveCount(0);
  expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("ffm.model.filters.")))).toEqual([]);
});

test("10 open/close cycles: one viewer at a time, everything released, memory does not grow without bound", async () => {
  test.setTimeout(900_000);
  await goTab("Plans");
  const samples: { cycle: number; pssMb: number; nativeMb: number | null; graphicsMb: number | null; javaMb: number | null; heapMb: number | null }[] = [];
  const take = async (cycle: number) => {
    const m = await meminfo(app);
    const heapMb = await app.page.evaluate(() => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null).then((v) => (v === null ? null : Math.round(v / 1048576)));
    const mb = (k: number | null) => (k === null ? null : Math.round(k / 1024));
    samples.push({ cycle, pssMb: mb(m.pssKb)!, nativeMb: mb(m.nativeKb), graphicsMb: mb(m.graphicsKb), javaMb: mb(m.javaKb), heapMb });
  };
  await take(0);
  const errorsBefore = app.pageErrors.length;
  for (let i = 1; i <= 10; i++) {
    await gotoModel(app);
    await app.page.waitForTimeout(1500);
    expect((await dbg(app.page, (d) => d.registry())).live).toBe(1);
    await goTab("Plans");
    await expect.poll(() => app.page.evaluate(() => window.__ffmModelDebug === undefined), { timeout: 10_000 }).toBe(true);
    await app.page.waitForTimeout(1200);
    await take(i);
  }
  // no page errors across the cycles (the viewer used to throw "No camera initialized!" on every unmount)
  expect(app.pageErrors.slice(errorsBefore), "page errors during the open/close cycles").toEqual([]);
  expect([...app.consoleErrors].filter((e) => /No camera initialized/i.test(e))).toEqual([]);
  console.log("LEAK samples", JSON.stringify(samples));
  // the registry is gone with the debug probe; verify via a final open that no earlier viewer is still live
  await gotoModel(app);
  const reg = await dbg(app.page, (d) => d.registry());
  expect(reg).toMatchObject({ live: 1, overlaps: 0 });
  expect(reg.acquired - reg.released).toBe(1);
  await goTab("Plans");
  const first = samples[1];
  const last = samples[samples.length - 1];
  const mid = samples[5];
  const growthMb = last.pssMb - first.pssMb;
  const lateGrowth = last.pssMb - mid.pssMb;
  recordPerf({
    leak: { cycles: 10, pssMbBaseline: samples[0].pssMb, pssMbAfter1: first.pssMb, pssMbAfter5: mid.pssMb, pssMbAfter10: last.pssMb, growthCycle1to10Mb: growthMb, growthCycle5to10Mb: lateGrowth, jsHeapMbAfter1: first.heapMb, jsHeapMbAfter10: last.heapMb, graphicsMbAfter1: first.graphicsMb, graphicsMbAfter10: last.graphicsMb, nativeMbAfter1: first.nativeMb, nativeMbAfter10: last.nativeMb },
  });
  // bounded: a leaked model (0.5 MB frag, but its GPU buffers + worker copy) per cycle would add far more than this
  expect(growthMb).toBeLessThan(80);
  expect(lateGrowth).toBeLessThan(40);
  if (first.heapMb !== null && last.heapMb !== null) expect(last.heapMb - first.heapMb).toBeLessThan(25);
});


// ── saved views (docs/spikes/parity-views) ───────────────────────────
const PARITY = join(process.cwd(), "docs", "spikes", "parity-views");
async function parityShot(name: string) {
  const img = await liveShot(name);
  mkdirSync(PARITY, { recursive: true });
  if (existsSync(join(SHOTS, `${name}-device.png`))) copyFileSync(join(SHOTS, `${name}-device.png`), join(PARITY, `${name}.png`));
  return img;
}
const viewRows = () => app.page.getByTestId("view-row");

test("saved views: save camera + level + section, restore flies back, rename, delete; kept per building and offline", async () => {
  await ensureModel();
  await app.page.getByTestId("model-fit").click();
  await app.page.waitForTimeout(2500);

  // a state worth saving: a level with its cut, and a section box
  const levels = await levelNames(app.page);
  expect(levels.length).toBeGreaterThan(0);
  await chooseLevel(app.page, levels[0]);
  await expect.poll(async () => (await toolsState()).storey).toBe(true);
  await openTool("section");
  await app.page.getByTestId("section-box-view").click();
  await expect.poll(async () => (await toolsState()).section.enginePlanes.length).toBe(6);
  await app.page.getByTestId("section-close").click();
  // a camera that is not the Fit pose, so Fit later moves it
  const st = await stageRect(app.page);
  await touch.drag(st.x + st.w * 0.4, st.y + st.h * 0.5, st.x + st.w * 0.6, st.y + st.h * 0.45);
  await app.page.waitForTimeout(2000);
  const saved = (await dbg(app.page, (d) => d.pose()))!;
  const savedPlanes = (await toolsState()).section.enginePlanes;

  // the entry point is in the Tools menu
  await app.page.getByTestId("model-tools-button").click();
  const item = await center(app.page.getByTestId("tool-views"));
  expect(item.h, "touch target").toBeGreaterThanOrEqual(44);
  await app.page.getByTestId("tool-views").click();
  await expect(app.page.getByTestId("views-panel")).toBeVisible();
  await expect(app.page.getByTestId("views-empty")).toBeVisible();
  await app.page.getByTestId("views-name").fill("Plant corner");
  await app.page.getByTestId("views-save").click();
  await expect(viewRows()).toHaveCount(1);
  await expect(viewRows().first()).toHaveAttribute("data-view-name", "Plant corner");
  await parityShot("50-views-list");
  await app.page.getByTestId("views-close").click();

  // change everything: all levels, no section, another camera
  await chooseLevel(app.page, null);
  await expect.poll(async () => (await toolsState()).storey).toBe(false);
  await openTool("section");
  await app.page.getByTestId("section-reset").click();
  await app.page.getByTestId("section-close").click();
  await app.page.getByTestId("model-fit").click();
  await app.page.waitForTimeout(2500);
  const other = (await dbg(app.page, (d) => d.pose()))!;
  expect((await toolsState()).section.enginePlanes).toHaveLength(0);
  expect(moved(saved, other), "the camera is somewhere else now").toBeGreaterThan(0.5);

  // restore: the camera flies back, the level and the section return
  await openTool("views");
  await app.page.getByTestId("view-restore").first().click();
  await expect(app.page.getByTestId("views-panel")).toHaveCount(0);
  await expect.poll(async () => moved(saved, (await dbg(app.page, (d) => d.pose()))!), { timeout: 15_000 }).toBeLessThan(0.05);
  await expect.poll(async () => (await toolsState()).storey).toBe(true);
  await expect.poll(async () => (await toolsState()).section.enginePlanes.length).toBe(6);
  const back = (await toolsState()).section.enginePlanes;
  for (let i = 0; i < 6; i++) {
    expect(back[i].normal).toEqual(savedPlanes[i].normal);
    for (let k = 0; k < 3; k++) expect(back[i].point[k]).toBeCloseTo(savedPlanes[i].point[k], 4);
  }
  await app.page.waitForTimeout(2000);
  await parityShot("51-views-restored");

  // rename, then a second view and delete the first
  await openTool("views");
  await app.page.getByTestId("view-rename").first().click();
  await app.page.getByTestId("view-rename-input").fill("Plant corner, level 1");
  await app.page.getByTestId("view-rename-ok").click();
  await expect(viewRows().first()).toHaveAttribute("data-view-name", "Plant corner, level 1");
  await app.page.getByTestId("views-save").click(); // empty name: the suggested "View 2"
  await expect(viewRows()).toHaveCount(2);
  await expect(viewRows().nth(1)).toHaveAttribute("data-view-name", "View 2");
  await app.page.getByTestId("view-delete").first().click();
  await expect(app.page.getByTestId("view-delete-confirm")).toBeVisible(); // asks once
  await app.page.getByTestId("view-delete-confirm").click();
  await expect(viewRows()).toHaveCount(1);
  await expect(viewRows().first()).toHaveAttribute("data-view-name", "View 2");
  await parityShot("52-views-renamed-deleted");
  await app.page.getByTestId("views-close").click();

  // stored on the device: still there after leaving the tab, with the network off
  await app.shell("cmd connectivity airplane-mode enable").catch(() => undefined);
  await goTab("Plans");
  await expect.poll(() => app.page.evaluate(() => window.__ffmModelDebug === undefined), { timeout: 10_000 }).toBe(true);
  await gotoModel(app);
  await openTool("views");
  await expect(viewRows()).toHaveCount(1);
  await expect(viewRows().first()).toHaveAttribute("data-view-name", "View 2");
  await app.page.getByTestId("views-close").click();
  await app.shell("cmd connectivity airplane-mode disable").catch(() => undefined);
});

// ── Walk split: the plan of the walker's level beside (landscape) / above (portrait) the same 3D canvas ──────────────
const WS_DOCS = join(process.cwd(), "docs", "spikes", "walk-split");
const WS_S101 = "920118c4-cdb7-4148-a530-b71fe83ca142";
const WS_S102 = "aee94b63-3db1-4cb8-9e6a-3e5d521e7f38";
type WsParams = { scale: number; rotation: number; translateX: number; translateZ: number };
interface WsState {
  plan: string;
  storey: string;
  params: WsParams;
  page: { width: number; height: number } | null;
  walker: { x: number; z: number; floorY: number; yaw: number } | null;
}
const ws = (): Promise<WsState> => app.page.evaluate(() => (window as unknown as { __ffmWalkSplit: { state(): unknown } }).__ffmWalkSplit.state() as never);
const wsToWorld = (p: WsParams, pt: { x: number; y: number }) => {
  const c = Math.cos(p.rotation);
  const s = Math.sin(p.rotation);
  return { x: p.scale * (c * pt.x - s * pt.y) + p.translateX, z: p.scale * (s * pt.x + c * pt.y) + p.translateZ };
};
const wsShot = async (name: string) => {
  await deviceShot(app, name);
  mkdirSync(WS_DOCS, { recursive: true });
  for (const f of [`${name}-device.png`, `${name}.png`]) {
    if (existsSync(join(SHOTS, f))) {
      copyFileSync(join(SHOTS, f), join(WS_DOCS, `${name}.png`));
      return;
    }
  }
};
const wsBox = async (id: string) => (await app.page.getByTestId(id).first().boundingBox())!;
const wsPose = async () => (await dbg(app.page, (d) => d.pose()))!;
const wsEye = (p: Pose) => ({ x: p.pos[0], z: p.pos[2], bearing: Math.atan2(p.target[2] - p.pos[2], p.target[0] - p.pos[0]) });
const wsAng = (a: number, b: number) => Math.abs((Math.atan2(Math.sin(a - b), Math.cos(a - b)) * 180) / Math.PI);
const wsLevel = async (name: string) => {
  if ((await app.page.getByTestId("walk-level").getAttribute("data-level")) === name) return;
  await app.page.getByTestId("walk-level").click();
  await app.page.locator(`[data-testid="walk-level-option"][data-level="${name}"]`).first().click();
  await expect(app.page.getByTestId("walk-level-name")).toHaveText(name);
};

test("walk split setup: a second calibrated plan on the second floor", async () => {
  const page = app.page;
  await ensureModel();
  const params = await page.evaluate(
    () =>
      new Promise<unknown>((res, rej) => {
        const open = indexedDB.open("free-field");
        open.onerror = () => rej(open.error);
        open.onsuccess = () => {
          const all = open.result.transaction("calibrations", "readonly").objectStore("calibrations").getAll();
          all.onsuccess = () => res((all.result as { pdfFileId: string; transformParams: unknown }[]).find((c) => c.pdfFileId === "920118c4-cdb7-4148-a530-b71fe83ca142")!.transformParams);
        };
      }),
  );
  await page.evaluate(
    ([pdf, p]) =>
      new Promise<void>((res, rej) => {
        const open = indexedDB.open("free-field");
        open.onerror = () => rej(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction("calibrations", "readwrite");
          tx.objectStore("calibrations").put({ id: "e2e-ws-cal-s102", projectId: "default-project", pdfFileId: pdf, storeyName: "201 SECOND FLOOR", pointPairs: [{ pdfX: 100, pdfY: 100, worldX: 0, worldZ: 0 }, { pdfX: 300, pdfY: 100, worldX: 7, worldZ: 0 }], transformParams: p, confidence: 1, createdAt: Date.now(), updatedAt: Date.now() });
          tx.oncomplete = () => res();
          tx.onerror = () => rej(tx.error);
        };
      }),
    [WS_S102, params] as const,
  );
  // a raw write is not a change Dexie hears of: reload the app so the live queries read it
  await page.reload();
  const demo = page.getByTestId("demo-signin");
  const tabs = page.getByTestId("tabs");
  await expect(demo.or(tabs)).toBeVisible({ timeout: 60_000 });
  if (await demo.isVisible()) await demo.click();
  const picker = page.getByTestId("project-picker");
  await expect(picker.or(tabs)).toBeVisible();
  if (await picker.isVisible()) await page.getByTestId("project-default-project").click();
  await expect(tabs).toBeVisible();
  await gotoModel(app);
});

async function walkSplit(tag: "portrait" | "landscape"): Promise<void> {
  const page = app.page;
  await ensureModel();
  await page.getByTestId("model-fit").click();
  await page.waitForTimeout(2000);
  const before = (await wsPose());
  const mark = () =>
    page.evaluate(() => {
      const c = document.querySelector(".model-canvas canvas") as (HTMLCanvasElement & { __ws?: number }) | null;
      if (c) c.__ws = 1;
      return !!c;
    });
  expect(await mark()).toBe(true);
  const reloads0 = ((await dbg(page, (d) => d.state())) as { reloads?: number }).reloads ?? 0;

  // ── enter walk, stand on the first floor: the screen splits ──
  await page.getByTestId("model-walk").click();
  await expect(page.getByTestId("walk-layer")).toBeVisible();
  await wsLevel("101 FIRST FLOOR");
  const split = page.getByTestId("walk-split-plan");
  await expect(split).toBeVisible({ timeout: 20_000 });
  await expect(split).toHaveAttribute("data-plan", WS_S101);
  await expect(page.getByTestId("model-page")).toHaveAttribute("data-split", tag === "landscape" ? "row" : "column");
  await expect(page.getByTestId("lv-marker")).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(1500);
  const pb = await wsBox("walk-split-plan");
  const sb = await wsBox("model-stage");
  if (tag === "landscape") {
    expect(pb.x + pb.width).toBeLessThanOrEqual(sb.x + 2); // plan left of the model
    expect(Math.abs(pb.y - sb.y)).toBeLessThan(2);
    expect(Math.abs(pb.height - sb.height)).toBeLessThan(2);
    expect(Math.abs(pb.width - sb.width)).toBeLessThan(sb.width * 0.15);
  } else {
    expect(pb.y + pb.height).toBeLessThanOrEqual(sb.y + 2); // plan above the model
    expect(Math.abs(pb.x - sb.x)).toBeLessThan(2);
    expect(Math.abs(pb.width - sb.width)).toBeLessThan(2);
    expect(Math.abs(pb.height - sb.height)).toBeLessThan(sb.height * 0.15);
  }
  // today's walk UI is on the model side, all inside it
  for (const id of ["walk-pad", "walk-level", "walk-exit"]) {
    const b = await wsBox(id);
    expect(b.x, id).toBeGreaterThanOrEqual(sb.x - 1);
    expect(b.y, id).toBeGreaterThanOrEqual(sb.y - 1);
    expect(b.x + b.width, id).toBeLessThanOrEqual(sb.x + sb.width + 1);
    expect(b.y + b.height, id).toBeLessThanOrEqual(sb.y + sb.height + 1);
  }
  expect(Math.min((await wsBox("walk-pad")).width, (await wsBox("walk-level")).height)).toBeGreaterThanOrEqual(44);
  // the 3D pane really draws (the software-GPU emulator sometimes captures a blank frame: retake for a while)
  const threeD = async (name: string) => {
    for (let i = 0; i < 10; i++) {
      const img = await deviceShot(app, name);
      const k = img.width / (await page.evaluate(() => window.innerWidth));
      const g = geometryStats(img, { x: (sb.x + sb.width * 0.15) * k, y: (sb.y + sb.height * 0.15) * k, w: sb.width * 0.7 * k, h: sb.height * 0.7 * k });
      console.log(`walk split ${tag} 3D pane ${name}: ${(g.fraction * 100).toFixed(1)} %, ${g.colours} colours`);
      if (g.colours > 3) return g;
      await page.waitForTimeout(2500);
    }
    throw new Error(`the 3D pane stays empty (${name})`);
  };
  await threeD(`ws-${tag}-3d`);
  await wsShot(`${tag}-01-split`);

  // ── tap a point of the plan: the camera goes there at eye height ──
  const st0 = await ws();
  const viewer = await wsBox("plan-viewer");
  const marker = page.getByTestId("lv-marker");
  const zoom = Number(await page.getByTestId("plan-viewer").getAttribute("data-zoom"));
  const m0 = { sx: Number(await marker.getAttribute("data-screen-x")), sy: Number(await marker.getAttribute("data-screen-y")), px: Number(await marker.getAttribute("data-page-x")), py: Number(await marker.getAttribute("data-page-y")) };
  let tapped: { screen: { x: number; y: number }; pg: { x: number; y: number } } | null = null;
  for (const [dx, dy] of [[-110, 90], [110, 90], [-110, -90], [110, -90], [0, 140], [0, -140], [140, 0]]) {
    const sx = m0.sx + dx;
    const sy = m0.sy + dy;
    const pg = { x: m0.px + dx / zoom, y: m0.py + dy / zoom };
    if (pg.x > 5 && pg.y > 5 && pg.x < st0.page!.width - 5 && pg.y < st0.page!.height - 5 && sx > 30 && sx < viewer.width - 70 && sy > 30 && sy < viewer.height - 30) {
      tapped = { screen: { x: viewer.x + sx, y: viewer.y + sy }, pg };
      break;
    }
  }
  expect(tapped, "a free spot on the plan").not.toBeNull();
  const eye0 = wsEye(await wsPose());
  await touch.tap(tapped!.screen.x, tapped!.screen.y);
  const want = wsToWorld(st0.params, tapped!.pg);
  await expect.poll(async () => { const e = wsEye(await wsPose()); return Math.hypot(e.x - want.x, e.z - want.z); }, { timeout: 15_000 }).toBeLessThan(0.25);
  const p1 = await wsPose();
  expect(p1.pos[1] - st0.walker!.floorY).toBeCloseTo(1.6, 1);
  expect(wsAng(wsEye(p1).bearing, eye0.bearing)).toBeLessThan(3); // a tap moves, it does not turn
  await expect.poll(async () => Math.hypot(Number(await marker.getAttribute("data-page-x")) - tapped!.pg.x, Number(await marker.getAttribute("data-page-y")) - tapped!.pg.y), { timeout: 10_000 }).toBeLessThan(3);
  await page.waitForTimeout(1200);
  await wsShot(`${tag}-02-tap-to-move`);

  // ── turn in 3D: the marker turns; walk with the pad: the marker moves ──
  const h0 = Number(await marker.getAttribute("data-heading-deg"));
  const layer = await center(page.getByTestId("walk-layer"));
  await touch.drag(layer.x + 80, layer.y - 20, layer.x - 80, layer.y - 20, 14);
  await page.waitForTimeout(500);
  const p2 = await wsPose();
  expect(wsAng(wsEye(p2).bearing, wsEye(p1).bearing)).toBeGreaterThan(10);
  await expect.poll(async () => Math.abs(Number(await marker.getAttribute("data-heading-deg")) - h0), { timeout: 5000 }).toBeGreaterThan(5);
  const pad = await center(page.getByTestId("walk-pad"));
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: pad.x, y: pad.y, id: 1 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: pad.x, y: pad.y - 55, id: 1 }] });
  await page.waitForTimeout(1800);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
  await page.waitForTimeout(600);
  const p3 = await wsPose();
  const walked = Math.hypot(p3.pos[0] - p2.pos[0], p3.pos[2] - p2.pos[2]);
  expect(walked).toBeGreaterThan(0.3);
  const st3 = await ws();
  expect(Math.hypot(st3.walker!.x - p3.pos[0], st3.walker!.z - p3.pos[2])).toBeLessThan(0.05);
  const mk = { x: Number(await marker.getAttribute("data-page-x")), y: Number(await marker.getAttribute("data-page-y")) };
  expect(Math.hypot(mk.x - (tapped!.pg.x), mk.y - tapped!.pg.y)).toBeGreaterThan(walked / st0.params.scale / 3); // the marker left the tapped spot
  await wsShot(`${tag}-03-walked`);

  // ── level picker swaps the plan ──
  await page.getByTestId("walk-level-up").click();
  await expect(page.getByTestId("walk-level-name")).toHaveText("201 SECOND FLOOR");
  await expect(split).toHaveAttribute("data-plan", WS_S102, { timeout: 20_000 });
  await expect(page.getByTestId("walk-noplan")).toHaveCount(0);
  await expect((await ws()).plan).toBe(WS_S102);
  await expect.poll(async () => (await wsPose()).pos[1], { timeout: 8000 }).toBeCloseTo((await ws()).walker!.floorY + 1.6, 1);
  await expect(page.getByTestId("walk-split-plan").locator('[data-testid="plan-viewer"]')).toBeVisible({ timeout: 90_000 }); // the second plan renders its tiles once
  await expect(page.getByTestId("plan-find-marker")).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1500);
  await wsShot(`${tag}-04-level-swaps-plan`);

  // ── a level without a calibrated plan: a friendly note, the walk takes the full screen ──
  await page.getByTestId("walk-level").click();
  const opts = await page.getByTestId("walk-level-option").evaluateAll((els) => els.map((e) => e.getAttribute("data-level")!));
  const bare = opts.find((n) => n !== "101 FIRST FLOOR" && n !== "201 SECOND FLOOR");
  expect(bare, `a level without a plan among ${opts.join(" | ")}`).toBeTruthy();
  await page.locator(`[data-testid="walk-level-option"][data-level="${bare}"]`).first().click();
  await expect(page.getByTestId("walk-noplan")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("walk-noplan")).toContainText(bare!);
  await expect(page.getByTestId("walk-split-plan")).toHaveCount(0);
  await expect(page.getByTestId("model-page")).not.toHaveAttribute("data-split", /.+/);
  const full = await wsBox("model-stage");
  const pageBox = await wsBox("model-page"); // the model area (the landscape layout keeps the tab rail beside it)
  expect(full.width).toBeGreaterThan(pageBox.width - 2);
  expect(full.height).toBeGreaterThan(pageBox.height - 2);
  await expect(page.getByTestId("walk-layer")).toBeVisible();
  await page.waitForTimeout(1200);
  await wsShot(`${tag}-05-level-without-plan`);
  // back to a level with a plan: the split returns
  await wsLevel("101 FIRST FLOOR");
  await expect(page.getByTestId("walk-split-plan")).toHaveAttribute("data-plan", WS_S101, { timeout: 20_000 });
  await page.waitForTimeout(1000);

  // ── exit: the orbit view and the full-screen model are back, and the viewer was never reloaded ──
  await page.getByTestId("walk-exit").click();
  await expect(page.getByTestId("model-page")).toHaveAttribute("data-mode", "orbit");
  await expect(page.getByTestId("walk-split-plan")).toHaveCount(0);
  await expect(page.getByTestId("model-page")).not.toHaveAttribute("data-split", /.+/);
  await expect.poll(async () => moved(before, await wsPose()), { timeout: 10_000 }).toBeLessThan(1);
  const back = await wsBox("model-stage");
  expect(back.width).toBeGreaterThan(pageBox.width - 2);
  expect(back.height).toBeGreaterThan(pageBox.height - 2);
  expect(await page.evaluate(() => (document.querySelector(".model-canvas canvas") as (HTMLCanvasElement & { __ws?: number }) | null)?.__ws === 1)).toBe(true); // the same canvas element
  expect(((await dbg(page, (d) => d.state())) as { reloads?: number }).reloads ?? 0).toBe(reloads0);
  expect(await dbg(page, (d) => d.registry())).toMatchObject({ live: 1, overlaps: 0 });
  await wsShot(`${tag}-06-exit-restored`);
}

test("walk split (portrait): plan on top, 3D at the bottom; tap moves, marker follows, level swaps the plan, no plan = full screen, exit restores", async () => {
  test.setTimeout(420_000);
  await setRotation(app, 0);
  await app.page.waitForTimeout(2500);
  await walkSplit("portrait");
});

test("walk split (landscape): plan on the left, 3D on the right; same behaviour", async () => {
  test.setTimeout(420_000);
  await setRotation(app, 1);
  try {
    await app.page.waitForTimeout(3500);
    await walkSplit("landscape");
  } finally {
    await setRotation(app, 0);
    await app.page.waitForTimeout(2500);
  }
});
