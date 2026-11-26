import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchApp, touchSession, PKG, SHOTS, type AppSession } from "./app";

/**
 * Heavy federation pass on the physical tablet (needs the perf build: `pnpm --filter @ffm/mobile android:debug:perf`,
 * test hooks on, every demo model bundled). The workload is the demo building repeated FFM_HEAVY_N times as a campus
 * (default 4: ~474 MB of .frag, twelve models, see model/heavyCampus.ts); FFM_HEAVY_N=1 runs the plain 3-model demo.
 * FFM_MEMCFG is a JSON memory-tuning override (localStorage ffm.memCfg); FFM_HEAVY_LABEL names the report
 * (test-results/heavy-3d-<label>.json). Skipped unless FFM_ALLOW_DEVICE is set (scripts/device-session.sh).
 */
test.skip(!process.env.FFM_ALLOW_DEVICE, "physical tablet only (FFM_ALLOW_DEVICE)");
test.describe.configure({ mode: "serial" });

const N = Number(process.env.FFM_HEAVY_N ?? 4);
const MODELS = 3 * N;
const LABEL = process.env.FFM_HEAVY_LABEL ?? `n${N}`;
const CYCLES = Number(process.env.FFM_HEAVY_CYCLES ?? 5);

let app: AppSession;
let touch: Awaited<ReturnType<typeof touchSession>>;
const report: Record<string, unknown> = { n: N, models: MODELS, memCfg: process.env.FFM_MEMCFG ?? null };
const adb = (cmd: string) => execFileSync("adb", ["-s", process.env.ANDROID_SERIAL!, "shell", cmd], { encoding: "utf8", maxBuffer: 64 << 20 });

function memory() {
  const own = adb(`dumpsys meminfo ${PKG}`);
  const num = (s: string, re: RegExp) => Number(re.exec(s)?.[1] ?? 0);
  let rendererKb = 0;
  let rendererPid = "";
  for (const line of adb("dumpsys meminfo").split("\n")) {
    const m = /^\s*([\d,]+)K:\s+(\S*sandboxed_process\S*) \(pid (\d+)/.exec(line);
    if (m) {
      const kb = Number(m[1].replace(/,/g, ""));
      if (kb > rendererKb) {
        rendererKb = kb;
        rendererPid = m[3]; // the big renderer, not a small helper sandbox process
      }
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
type Mem = ReturnType<typeof memory>;
const combined = (m: Mem) => m.rendererPssMb + m.rendererSwapMb;
const note = (k: string, v: unknown) => {
  report[k] = v;
  console.log("HEAVY", k, JSON.stringify(v));
  mkdirSync(SHOTS, { recursive: true });
  writeFileSync(join(SHOTS, `heavy-3d-${LABEL}.json`), JSON.stringify(report, null, 2));
};
const modelAttr = async (name: string) => app.page.getByTestId("model-page").getAttribute(name, { timeout: 3000 }).catch(() => null);
const loaded = async () => Number((await modelAttr("data-loaded")) ?? 0);
const peaks = { rendererCombinedMb: 0, minAvailableMb: 1e9, rendererPids: new Set<string>() };
const watch = (m: Mem) => {
  peaks.rendererCombinedMb = Math.max(peaks.rendererCombinedMb, combined(m));
  peaks.minAvailableMb = Math.min(peaks.minAvailableMb, m.memAvailableMb);
  if (m.rendererPid) peaks.rendererPids.add(m.rendererPid);
  note("peaks", { rendererPssPlusSwapMb: peaks.rendererCombinedMb, minMemAvailableMb: peaks.minAvailableMb, rendererPids: [...peaks.rendererPids] });
  return m;
};

const installLongTasks = () =>
  app.page.evaluate(() => {
    const w = window as unknown as { __lt: Array<[number, number]>; __ltT0: number };
    w.__lt = [];
    w.__ltT0 = performance.now();
    try {
      new PerformanceObserver((l) => l.getEntries().forEach((e) => w.__lt.push([Math.round(e.startTime), Math.round(e.duration)]))).observe({ entryTypes: ["longtask"] });
    } catch {
      /* unsupported */
    }
  });
const longTasks = () => app.page.evaluate(() => (window as unknown as { __lt?: Array<[number, number]> }).__lt ?? []);

async function openModelTab(): Promise<{ marks: Record<number, number>; readyMs: number | null; t0: number; inPage: unknown }> {
  await app.page.evaluate(() => {
    delete (window as unknown as { __ffmReads?: unknown }).__ffmReads;
    delete (window as unknown as { __ffmLoadMarks?: unknown }).__ffmLoadMarks;
  });
  const t0 = Date.now();
  // the in-page clock at the click, so first geometry is measured from the tap on the tab (not from the viewer mount)
  await app.page.evaluate(() => {
    document.querySelector('[data-testid="tabs"]')?.addEventListener("click", () => ((window as unknown as { __clickAt: number }).__clickAt = performance.now()), { capture: true, once: true });
  });
  await app.page.getByTestId("tabs").getByRole("link", { name: "Model", exact: true }).click();
  const marks: Record<number, number> = {};
  let readyMs: number | null = null;
  while (Date.now() - t0 < 180_000) {
    const n = await loaded();
    if (n > 0 && marks[n] === undefined) marks[n] = Date.now() - t0;
    watch(memory());
    if (n >= MODELS && (await modelAttr("data-phase")) === "ready") {
      readyMs = Date.now() - t0;
      break;
    }
    await app.page.waitForTimeout(250);
  }
  const inPage = await app.page.evaluate(() => {
    const w = window as unknown as { __ffmLoadMarks?: { mountedAt?: number; firstTrianglesMs: number | null; loaded: Array<[number, number]> }; __clickAt?: number };
    const m = w.__ffmLoadMarks;
    if (!m || m.mountedAt === undefined || w.__clickAt === undefined) return m ?? null;
    const base = m.mountedAt - w.__clickAt; // mount happens this long after the tap
    return { ...m, fromTap: { mountMs: Math.round(base), firstModelMs: Math.round(base + (m.loaded[0]?.[0] ?? 0)), firstTrianglesMs: m.firstTrianglesMs === null ? null : Math.round(base + m.firstTrianglesMs), allLoadedMs: Math.round(base + (m.loaded.at(-1)?.[0] ?? 0)) } };
  });
  return { marks, readyMs, t0, inPage };
}

test.beforeAll(async () => {
  app = await launchApp();
  await app.page.getByTestId("demo-signin").click();
  const picker = app.page.getByTestId("project-picker");
  const tabs = app.page.getByTestId("tabs");
  await expect(picker.or(tabs)).toBeVisible({ timeout: 60_000 });
  if (await picker.isVisible()) await app.page.getByTestId("project-default-project").click();
  await expect(tabs).toBeVisible();
  await app.page.evaluate(([n, cfg, prog]) => {
    if (prog === "0") localStorage.setItem("ffm.progressive", "0");
    else localStorage.removeItem("ffm.progressive");
    if (n > 1) localStorage.setItem("ffm.heavy", String(n));
    else localStorage.removeItem("ffm.heavy");
    if (cfg) localStorage.setItem("ffm.memCfg", cfg);
    else localStorage.removeItem("ffm.memCfg");
  }, [N, process.env.FFM_MEMCFG ?? "", process.env.FFM_PROGRESSIVE ?? "1"] as const);
  touch = await touchSession(app.page);
  note("baseline", watch(memory()));
});
test.afterAll(async () => {
  await touch?.detach().catch(() => undefined);
  await app?.close();
});

test("heavy federation loads", async () => {
  test.setTimeout(420_000);
  await installLongTasks();
  const { marks, readyMs, t0, inPage } = await openModelTab();
  note("loadMs", { loadedAt: marks, allReadyMs: readyMs });
  note("loadMarksInPage", inPage);
  const lt = await longTasks();
  const t0Page = await app.page.evaluate(() => (window as unknown as { __ltT0: number }).__ltT0);
  const firstMs = marks[Math.min(...Object.keys(marks).map(Number))] ?? 0;
  const after = lt.filter(([s]) => s - t0Page > firstMs);
  note("longTasks", { total: lt.length, worstMs: Math.max(0, ...lt.map(([, d]) => d)), afterFirstGeometry: { count: after.length, worstMs: Math.max(0, ...after.map(([, d]) => d)), over500: after.filter(([, d]) => d > 500).length } });
  await app.page.waitForTimeout(4000);
  note("afterLoad", watch(memory()));
  const pid = String((report.afterLoad as Mem).rendererPid);
  if (pid) {
    const raw = adb(`dumpsys meminfo ${pid}`);
    writeFileSync(join(SHOTS, `heavy-3d-${LABEL}-renderer-meminfo.txt`), raw);
    const pick = (re: RegExp) => Number(re.exec(raw)?.[1] ?? 0);
    note("rendererBreakdownKb", { nativeHeap: pick(/Native Heap:?\s+(\d+)/), dalvik: pick(/Dalvik Heap:?\s+(\d+)/), ashmem: pick(/Ashmem:?\s+(\d+)/), gl: pick(/GL mtrack:?\s+(\d+)/), egl: pick(/EGL mtrack:?\s+(\d+)/), otherDev: pick(/Other dev:?\s+(\d+)/), total: pick(/TOTAL PSS:\s+(\d+)/) });
  }
  await app.shot(`heavy-3d-${LABEL}-loaded`);
  expect(Date.now() - t0).toBeGreaterThan(0);
  expect(await loaded()).toBe(MODELS);
});

test("orbit frame rate", async () => {
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
  note("afterOrbit", watch(memory()));
  await app.page.getByTestId("model-fit").click();
  await app.page.waitForTimeout(2500);
});

/** A screen point (fraction of the stage) where the tap test found geometry: the measure test aims there. */
let hit: [number, number] = [0.5, 0.55];

test("tap an element: properties", async () => {
  const stage = (await app.page.getByTestId("model-page").boundingBox())!;
  const pts = [[0.5, 0.5], [0.45, 0.55], [0.55, 0.45], [0.5, 0.6], [0.4, 0.5], [0.6, 0.55], [0.35, 0.45]];
  const times: number[] = [];
  for (const [fx, fy] of pts) {
    const t0 = Date.now();
    await touch.tap(stage.x + stage.width * fx, stage.y + stage.height * fy);
    const ok = await app.page.getByTestId("props-attrs").or(app.page.getByTestId("props-error")).first().waitFor({ timeout: 15_000 }).then(() => true, () => false);
    if (ok) {
      if (!times.length) hit = [fx, fy];
      times.push(Date.now() - t0);
      await app.page.getByTestId("props-close").click();
      if (times.length >= 3) break;
    }
  }
  note("tapToProperties", { msSamples: times, medianMs: [...times].sort((a, b) => a - b)[Math.floor(times.length / 2)] ?? null });
  note("afterTap", watch(memory()));
  expect(times.length).toBeGreaterThan(0);
});

test("measure, then walk", async () => {
  await app.page.getByTestId("model-measure").click();
  const bar = app.page.getByTestId("measure3d-bar");
  await expect(bar).toBeVisible();
  if ((await bar.getAttribute("data-variant")) === "volume") await app.page.getByRole("button", { name: /Length/ }).click();
  const stage = (await app.page.getByTestId("model-page").boundingBox())!;
  const t0 = Date.now();
  const [hx, hy] = hit;
  await touch.tap(stage.x + stage.width * hx, stage.y + stage.height * hy);
  await expect(bar).toHaveAttribute("data-plane", "1", { timeout: 15_000 });
  note("planePickMs", Date.now() - t0);
  await touch.tap(stage.x + stage.width * (hx - 0.03), stage.y + stage.height * hy);
  await touch.tap(stage.x + stage.width * (hx + 0.03), stage.y + stage.height * hy);
  await app.page.waitForTimeout(1500);
  note("measureBar", { placed: await bar.getAttribute("data-placed") });
  note("afterMeasure", watch(memory()));
  await app.page.getByTestId("model-measure").click();
  await app.page.getByTestId("model-walk").click();
  await expect(app.page.getByTestId("model-page")).toHaveAttribute("data-mode", "walk");
  await app.page.waitForTimeout(2000);
  note("duringWalk", watch(memory()));
  await app.shot(`heavy-3d-${LABEL}-walk`);
  await app.page.getByTestId("walk-exit").click();
  note("afterTools", watch(memory()));
});

test("open and close the model tab", async () => {
  test.setTimeout(900_000);
  const cycles: unknown[] = [];
  for (let i = 0; i < CYCLES; i++) {
    await app.page.getByTestId("tabs").getByRole("link", { name: "Plans", exact: true }).click();
    await app.page.waitForTimeout(2500);
    const { marks, readyMs, inPage } = await openModelTab();
    await app.page.waitForTimeout(2000);
    const m = watch(memory());
    cycles.push({ i, firstLoadedMs: marks[Math.min(...Object.keys(marks).map(Number))] ?? null, readyMs, inPage, loaded: await loaded(), mem: m });
    note("cycles", cycles);
  }
  note("end", watch(memory()));
  note("rendererDied", peaks.rendererPids.size > 1);
  expect(peaks.rendererPids.size).toBeLessThanOrEqual(1);
});
