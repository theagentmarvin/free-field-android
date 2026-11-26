import { expect, type Locator, type Page } from "@playwright/test";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PKG, SHOTS, type AppSession } from "./app";
import { decodePng, geometryStats, type Raster, type Region } from "./png";

export interface Pose {
  pos: [number, number, number];
  target: [number, number, number];
  fov: number;
  isOrtho: boolean;
}

export interface DebugApi {
  state(): Record<string, unknown>;
  pose(): Pose | null;
  pixelRatio(): number | null;
  overlay(): { running: boolean; frames: number; runs: number } | null;
  renderStats(): { renders?: number; frames?: number } | null;
  registry(): { live: number; peak: number; acquired: number; released: number; overlaps: number };
  loseContext(): boolean;
  simulateBackground(ms: number): Promise<void>;
  pinScreen(taskId: string): { x: number; y: number; handle: { x: number; y: number } | null; visible: boolean } | null;
  stage(): { x: number; y: number; w: number; h: number } | null;
  elementAt(x: number, y: number): Promise<{ modelId: string; localId: number; point: [number, number, number] } | null>;
  heapMb(): number | null;
  modelBoxes(): { modelId: string; min: [number, number, number]; max: [number, number, number] }[];
  measureItems(): { variant: "length" | "area" | "angle"; points: [number, number, number][] }[];
  models(): ReadonlyMap<string, unknown>;
  drawStats(): { calls: number; triangles: number } | null;
  tools(): {
    panel: string | null;
    section: { box: boolean; planes: number; enginePlanes: Array<{ point: [number, number, number]; normal: [number, number, number] }> };
    hiddenModels: string[];
    hiddenCategories: string[];
    isolated: boolean;
    storey: boolean;
    xray: boolean;
    hiddenCount: Record<string, { all: boolean; n: number }>;
  };
  sampleElement(skip?: number): Promise<{ modelId: string; localId: number; guid: string | null; name: string | null } | null>;
  selectionScreen(): Promise<{ x: number; y: number; onScreen: boolean } | null>;
  thinCandidates(): Promise<{ modelId: string; localId: number; thickness: number; hits: number; x: number; y: number }[]>;
}

declare global {
  interface Window {
    __ffmModelDebug?: DebugApi;
  }
}

/** Run `fn(debugApi, arg)` in the page. */
export const dbg = <T, A = undefined>(page: Page, fn: (d: DebugApi, a: A) => T | Promise<T>, arg?: A): Promise<T> =>
  page.evaluate(([src, a]) => (new Function("d", "a", `return (${src})(d, a)`) as (d: unknown, a: unknown) => unknown)(window.__ffmModelDebug, a), [fn.toString(), arg] as [string, unknown]) as Promise<T>;

export const PERF_FILE = join(SHOTS, "model-perf.json");
export function recordPerf(entries: Record<string, unknown>): void {
  mkdirSync(SHOTS, { recursive: true });
  const cur = existsSync(PERF_FILE) ? (JSON.parse(readFileSync(PERF_FILE, "utf8")) as Record<string, unknown>) : {};
  writeFileSync(PERF_FILE, JSON.stringify({ ...cur, ...entries }, null, 2));
  console.log("MODEL PERF", JSON.stringify(entries));
}

export async function gotoModel(app: AppSession): Promise<void> {
  await app.page.getByTestId("tabs").getByRole("link", { name: "Model", exact: true }).click();
  await waitReady(app.page);
}

export async function waitReady(page: Page, timeout = 120_000): Promise<void> {
  await expect(page.getByTestId("model-page")).toHaveAttribute("data-phase", "ready", { timeout });
  // pins/overlay need the first frame
  await expect.poll(() => dbg(page, (d) => d.pose() !== null), { timeout: 30_000 }).toBe(true);
}

export const dist = (p: Pose) => Math.hypot(p.pos[0] - p.target[0], p.pos[1] - p.target[1], p.pos[2] - p.target[2]);
export const moved = (a: Pose, b: Pose) => Math.hypot(a.pos[0] - b.pos[0], a.pos[1] - b.pos[1], a.pos[2] - b.pos[2]);

export async function stageRect(page: Page) {
  const s = await dbg(page, (d) => d.stage());
  if (!s) throw new Error("no stage");
  return s;
}

/** Device framebuffer capture decoded to RGBA (the only capture that includes WebGL pixels). */
export async function deviceShot(app: AppSession, name: string): Promise<Raster> {
  const buf = await app.device.screenshot({ path: join(SHOTS, `${name}-device.png`) });
  return decodePng(buf);
}

/** Central part of the screen where the model stage is (toolbars and the status bar stay outside it). */
export function centralRegion(img: Raster): Region {
  return { x: img.width * 0.2, y: img.height * 0.3, w: img.width * 0.6, h: img.height * 0.45 };
}

/**
 * Geometry on the device framebuffer. On the software-GPU emulator the compositor occasionally shows a uniform (blank)
 * surface for a moment while a heavy frame is late: retake the capture every 3 s for up to 60 s (each blank one is
 * logged), then assert as before, so a model that never draws still fails.
 */
export async function expectGeometry(app: AppSession, name: string, min = 0.03, minColours = 8): Promise<{ fraction: number; colours: number }> {
  const t0 = Date.now();
  let blank = 0;
  for (;;) {
    const img = await deviceShot(app, name);
    const g = geometryStats(img, centralRegion(img));
    const ok = g.fraction > min && g.colours > minColours;
    if (ok || Date.now() - t0 > 60_000) {
      console.log(`geometry ${name}: ${(g.fraction * 100).toFixed(1)} % of pixels, ${g.colours} colours${blank ? ` (after ${blank} blank capture(s))` : ""}`);
      expect(g.fraction, `model geometry visible in ${name}`).toBeGreaterThan(min);
      expect(g.colours).toBeGreaterThan(minColours);
      return g;
    }
    blank++;
    console.log(`geometry ${name}: blank capture #${blank} (${(g.fraction * 100).toFixed(1)} %, ${g.colours} colours), retrying`);
    await app.page.waitForTimeout(3000);
  }
}

export async function center(l: Locator) {
  const b = (await l.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width, h: b.height };
}

export interface Mem {
  pssKb: number;
  nativeKb: number | null;
  graphicsKb: number | null;
  javaKb: number | null;
}

export async function meminfo(app: AppSession): Promise<Mem> {
  const out = await app.shell(`dumpsys meminfo ${PKG}`);
  const num = (re: RegExp) => {
    const m = re.exec(out);
    return m ? Number(m[1]) : null;
  };
  const pss = num(/TOTAL PSS:\s+(\d+)/) ?? num(/^\s*TOTAL\s+(\d+)/m);
  if (pss === null) throw new Error(`cannot parse meminfo:\n${out.slice(0, 600)}`);
  return { pssKb: pss, nativeKb: num(/Native Heap:\s+(\d+)/) ?? num(/Native Heap\s+(\d+)/), graphicsKb: num(/Graphics:\s+(\d+)/), javaKb: num(/Java Heap:\s+(\d+)/) ?? num(/Dalvik Heap\s+(\d+)/) };
}

/** Open the Filters sheet (no-op when it is open). */
export async function openFilters(page: Page): Promise<void> {
  if (!(await page.getByTestId("filters-sheet").count())) await page.getByTestId("model-filters").click();
  await expect(page.getByTestId("filters-sheet")).toBeVisible();
}

export async function closeFilters(page: Page): Promise<void> {
  if (await page.getByTestId("filters-sheet").count()) await page.getByTestId("filter-done").click();
  await expect(page.getByTestId("filters-sheet")).toHaveCount(0);
}

/** The storeys listed under Level (all levels excluded), through the sheet. */
export async function levelNames(page: Page): Promise<string[]> {
  await openFilters(page);
  const names = await page.getByTestId("filter-level").evaluateAll((els) => els.map((e) => e.getAttribute("data-level")!));
  await closeFilters(page);
  return names;
}

/** Choose a level (null = all levels) through the sheet and close it. */
export async function chooseLevel(page: Page, name: string | null): Promise<void> {
  await openFilters(page);
  await (name === null ? page.getByTestId("filter-level-all") : page.locator(`[data-testid="filter-level"][data-level="${name}"]`)).click();
  await closeFilters(page);
}
