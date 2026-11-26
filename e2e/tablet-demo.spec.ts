import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchApp, touchSession, PKG, SHOTS, type AppSession } from "./app";

/**
 * Physical-tablet pass on the shipping demo build (no test hooks): the full demo federation (every model the web
 * demo has), its load time and memory, orbit frame rate, tap-to-properties, plane-first measuring, the walk level
 * picker and the plumbing plan. Runs only with FFM_ALLOW_DEVICE (scripts/device-session.sh); skipped elsewhere.
 */
test.skip(!process.env.FFM_ALLOW_DEVICE, "physical tablet only (FFM_ALLOW_DEVICE)");
test.describe.configure({ mode: "serial" });

let app: AppSession;
let touch: Awaited<ReturnType<typeof touchSession>>;
const report: Record<string, unknown> = {};
const adb = (cmd: string) => execFileSync("adb", ["-s", process.env.ANDROID_SERIAL!, "shell", cmd], { encoding: "utf8", maxBuffer: 64 << 20 });

function memory() {
  const own = adb(`dumpsys meminfo ${PKG}`);
  const num = (s: string, re: RegExp) => Number(re.exec(s)?.[1] ?? 0);
  let rendererKb = 0;
  let rendererPid = "";
  for (const line of adb("dumpsys meminfo").split("\n")) {
    const m = /^\s*([\d,]+)K:\s+(\S*sandboxed_process\S*) \(pid (\d+)/.exec(line);
    if (m) {
      rendererKb = Math.max(rendererKb, Number(m[1].replace(/,/g, "")));
      rendererPid = m[3];
    }
  }
  const rendererSwapKb = rendererPid ? num(adb(`dumpsys meminfo ${rendererPid}`), /TOTAL SWAP PSS:\s+(\d+)/) : 0;
  const mb = (kb: number) => Math.round(kb / 1024);
  return {
    appPssMb: mb(num(own, /TOTAL PSS:\s+(\d+)/)),
    appSwapMb: mb(num(own, /TOTAL SWAP PSS:\s+(\d+)/)),
    rendererPssMb: mb(rendererKb),
    rendererSwapMb: mb(rendererSwapKb),
    rendererPid,
    memAvailableMb: mb(num(adb("cat /proc/meminfo"), /MemAvailable:\s+(\d+)/)),
  };
}
const note = (k: string, v: unknown) => {
  report[k] = v;
  console.log("TABLET", k, JSON.stringify(v));
  writeFileSync(join(SHOTS, "tablet-demo.json"), JSON.stringify(report, null, 2));
};
const loaded = async () => Number(await app.page.getByTestId("model-page").getAttribute("data-loaded").catch(() => "0"));

test.beforeAll(async () => {
  app = await launchApp();
  await app.page.getByTestId("demo-signin").click();
  const picker = app.page.getByTestId("project-picker");
  const tabs = app.page.getByTestId("tabs");
  await expect(picker.or(tabs)).toBeVisible({ timeout: 60_000 });
  if (await picker.isVisible()) await app.page.getByTestId("project-default-project").click();
  await expect(tabs).toBeVisible();
  touch = await touchSession(app.page);
  note("baseline", memory());
});
test.afterAll(async () => {
  await touch?.detach().catch(() => undefined);
  await app?.close();
});

test("all demo models load together", async () => {
  test.setTimeout(300_000);
  const t0 = Date.now();
  await app.page.getByTestId("tabs").getByRole("link", { name: "Model", exact: true }).click();
  const marks: Record<number, number> = {};
  let peak = memory();
  while (Date.now() - t0 < 240_000) {
    const n = await loaded();
    if (n > 0 && marks[n] === undefined) marks[n] = Date.now() - t0;
    const m = memory();
    if (m.rendererPssMb + m.rendererSwapMb > peak.rendererPssMb + peak.rendererSwapMb) peak = m;
    if (n >= 3 && (await app.page.getByTestId("model-page").getAttribute("data-phase")) === "ready") break;
    await app.page.waitForTimeout(500);
  }
  note("loadMs", marks);
  note("peakDuringLoad", peak);
  await app.page.waitForTimeout(3000);
  note("afterLoad", memory());
  await app.shot("tablet-demo-federated");
  expect(await loaded()).toBe(3);
});

test("orbit frame rate with the full federation", async () => {
  const stage = (await app.page.getByTestId("model-page").boundingBox())!;
  const cx = stage.x + stage.width / 2;
  const cy = stage.y + stage.height / 2;
  await app.page.evaluate(() => {
    const w = window as unknown as { __fr: number[]; __frOn: boolean };
    w.__fr = [];
    w.__frOn = true;
    const tick = (t: number) => {
      w.__fr.push(t);
      if (w.__frOn) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  for (let i = 0; i < 4; i++) {
    await touch.drag(cx - 200, cy, cx + 200, cy + 40, 30);
    await touch.drag(cx + 200, cy + 40, cx - 200, cy, 30);
  }
  const frames = await app.page.evaluate(() => {
    const w = window as unknown as { __fr: number[]; __frOn: boolean };
    w.__frOn = false;
    return w.__fr;
  });
  const gaps = frames.slice(1).map((t, i) => t - frames[i]).sort((a, b) => a - b);
  const span = (frames.at(-1)! - frames[0]) / 1000;
  note("orbit", { fps: Math.round(frames.length / span), p50FrameMs: Math.round(gaps[Math.floor(gaps.length / 2)]), p95FrameMs: Math.round(gaps[Math.floor(gaps.length * 0.95)]), worstMs: Math.round(gaps.at(-1)!) });
  note("afterOrbit", memory());
  await app.page.getByTestId("model-fit").click();
  await app.page.waitForTimeout(2500);
});

test("tap an element: properties", async () => {
  const stage = (await app.page.getByTestId("model-page").boundingBox())!;
  const pts = [
    [0.5, 0.5],
    [0.45, 0.55],
    [0.55, 0.45],
    [0.5, 0.6],
    [0.4, 0.5],
  ];
  for (const [fx, fy] of pts) {
    const t0 = Date.now();
    await touch.tap(stage.x + stage.width * fx, stage.y + stage.height * fy);
    const ok = await app.page.getByTestId("props-attrs").or(app.page.getByTestId("props-error")).first().waitFor({ timeout: 15_000 }).then(() => true, () => false);
    if (ok) {
      note("tapToProperties", { ms: Date.now() - t0, title: await app.page.getByTestId("props-title").textContent() });
      await app.shot("tablet-demo-properties");
      await app.page.getByTestId("props-close").click();
      return;
    }
  }
  throw new Error("no element picked at 5 points");
});

test("measure starts by picking a plane", async () => {
  await app.page.getByTestId("model-measure").click();
  const bar = app.page.getByTestId("measure3d-bar");
  await expect(bar).toBeVisible();
  if ((await bar.getAttribute("data-variant")) === "volume") await app.page.getByRole("button", { name: /Length/ }).click();
  await expect(bar).toHaveAttribute("data-plane", "0");
  await expect(app.page.getByTestId("measure3d-hint")).toContainText("First tap the surface");
  const stage = (await app.page.getByTestId("model-page").boundingBox())!;
  const t0 = Date.now();
  await touch.tap(stage.x + stage.width / 2, stage.y + stage.height * 0.55);
  await expect(bar).toHaveAttribute("data-plane", "1", { timeout: 15_000 });
  note("planePickMs", Date.now() - t0);
  await touch.tap(stage.x + stage.width * 0.42, stage.y + stage.height * 0.55);
  await touch.tap(stage.x + stage.width * 0.58, stage.y + stage.height * 0.55);
  await app.page.waitForTimeout(1500);
  note("measureBar", { placed: await bar.getAttribute("data-placed"), text: (await bar.textContent())?.slice(0, 160) });
  await app.shot("tablet-demo-measure");
  await app.page.getByTestId("model-measure").click();
});

test("walk with the level picker", async () => {
  await app.page.getByTestId("model-walk").click();
  await expect(app.page.getByTestId("model-page")).toHaveAttribute("data-mode", "walk");
  await expect(app.page.getByTestId("walk-levels")).toBeVisible();
  const before = await app.page.getByTestId("walk-level").getAttribute("data-level");
  const up = app.page.getByTestId("walk-level-up");
  if (await up.isEnabled()) await up.click();
  else await app.page.getByTestId("walk-level-down").click();
  await app.page.waitForTimeout(1500);
  note("walkLevels", { before, after: await app.page.getByTestId("walk-level").getAttribute("data-level") });
  await app.shot("tablet-demo-walk");
  await app.page.getByTestId("walk-exit").click();
  note("afterTools", memory());
});

test("plumbing plan renders", async () => {
  await app.page.getByTestId("tabs").getByRole("link", { name: "Plans", exact: true }).click();
  const row = app.page.getByTestId("plan-row").filter({ hasText: "P-101" });
  await expect(row).toBeVisible({ timeout: 30_000 });
  const t0 = Date.now();
  await row.getByTestId("plan-open").click();
  const viewer = app.page.getByTestId("plan-viewer");
  await expect(viewer).toBeVisible({ timeout: 60_000 });
  // First paint (the whole sheet as an overview) is recorded apart from the first sharp tile; pass criteria are unchanged.
  await expect.poll(async () => (await viewer.getAttribute("data-first-paint-ms")) ?? "", { timeout: 90_000 }).not.toBe("");
  note("plumbingFirstPaintWallMs", Date.now() - t0);
  note("plumbingFirstPaintMs", Number(await viewer.getAttribute("data-first-paint-ms")));
  await expect.poll(async () => Number(await viewer.getAttribute("data-drawn")), { timeout: 90_000 }).toBeGreaterThan(0);
  note("plumbingPlanMs", Date.now() - t0);
  note("plumbingFirstSharpTileMs", Number(await viewer.getAttribute("data-first-tile-ms")));
  await app.page.waitForTimeout(2000);
  await app.shot("tablet-demo-plumbing");
  note("end", memory());
});
