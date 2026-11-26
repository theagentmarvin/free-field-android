import { describe, expect, it } from "vitest";
import { planLevels } from "../tileMath";
import { aspectMismatch, DIFF_MAX_PIXELS, fromBase, pickDiffLevel, regionCentre, revisionFrame, thresholdsForScale, toBase } from "./geometry";
import { changeLabel, diffRasters, summarizeChanges } from "./diff";
import { viewForBox } from "./drawCompare";
import type { RasterPage } from "./webCompare";

function blank(w: number, h: number): RasterPage {
  return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4).fill(255) };
}
function rect(p: RasterPage, x0: number, y0: number, x1: number, y1: number, rgb: [number, number, number] = [0, 0, 0]) {
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const i = (y * p.width + x) * 4;
      p.data[i] = rgb[0];
      p.data[i + 1] = rgb[1];
      p.data[i + 2] = rgb[2];
    }
}
/** A drawing: a frame and a few bars, so auto-align has something to lock onto. */
function drawing(dx = 0, dy = 0): RasterPage {
  const p = blank(320, 240);
  rect(p, 20 + dx, 20 + dy, 300 + dx, 24 + dy); // top bar
  rect(p, 20 + dx, 216 + dy, 300 + dx, 220 + dy); // bottom bar
  rect(p, 20 + dx, 20 + dy, 24 + dx, 220 + dy); // left bar
  rect(p, 296 + dx, 20 + dy, 300 + dx, 220 + dy); // right bar
  rect(p, 80 + dx, 80 + dy, 84 + dx, 160 + dy);
  rect(p, 140 + dx, 100 + dy, 200 + dx, 104 + dy);
  return p;
}
const inThread = { createWorker: () => null };
const level = { scale: 1 };
const page = { width: 320, height: 240 };

describe("revision frame (rescale and offset)", () => {
  it("keeps same-size pages as they are and rescales by width beyond 1 %", () => {
    expect(revisionFrame({ width: 3024, height: 2160 }, { width: 3024, height: 2160 })).toEqual({ s: 1, ox: 0, oy: 0 });
    expect(revisionFrame({ width: 1000, height: 700 }, { width: 1005, height: 700 }).s).toBe(1); // within 1 %
    expect(revisionFrame({ width: 1000, height: 700 }, { width: 2000, height: 1400 }).s).toBe(0.5);
    expect(revisionFrame({ width: 1000, height: 700 }, { width: 1000, height: 700 }, { x: 3, y: -2 })).toEqual({ s: 1, ox: 3, oy: -2 });
  });
  it("maps points both ways and flags a different aspect ratio", () => {
    const f = revisionFrame({ width: 1000, height: 700 }, { width: 2000, height: 1400 }, { x: 10, y: 5 });
    const b = toBase(f, 200, 100);
    expect(b).toEqual({ x: 110, y: 55 });
    expect(fromBase(f, b.x, b.y)).toEqual({ x: 200, y: 100 });
    expect(aspectMismatch({ width: 1000, height: 700 }, { width: 1000, height: 700 })).toBe(false);
    expect(aspectMismatch({ width: 1000, height: 700 }, { width: 1000, height: 800 })).toBe(true);
  });
});

describe("comparison raster size and thresholds", () => {
  it("picks the finest pyramid level within the pixel budget (never above it, at least the coarsest)", () => {
    const levels = planLevels(3024, 2160);
    const l = pickDiffLevel(levels);
    expect(l.width * l.height).toBeLessThanOrEqual(DIFF_MAX_PIXELS);
    const next = levels[l.z + 1];
    expect(next === undefined || next.width * next.height > DIFF_MAX_PIXELS).toBe(true);
    expect(pickDiffLevel(levels, 10).z).toBe(0);
  });
  it("scales the web preset from 144 dpi to the raster", () => {
    const web = thresholdsForScale(2);
    expect(web).toMatchObject({ colorThreshold: 48, proximityPx: 1, gridSize: 16, minPixelsPerCell: 6 }); // the web's "vector" preset
    const low = thresholdsForScale(0.5);
    expect(low.gridSize).toBe(4);
    expect(low.minPixelsPerCell).toBe(2);
  });
});

describe("diffRasters (web engine on tile rasters)", () => {
  it("finds an added and a removed element and names their kinds", async () => {
    const a = drawing();
    const b = drawing();
    rect(b, 220, 60, 224, 140); // added bar
    rect(b, 80, 80, 84, 160, [255, 255, 255]); // removed bar (far from the added one)
    const d = await diffRasters({ base: a, revision: b, level, basePage: page, revPage: page }, inThread);
    const kinds = d.regions.map((r) => r.kind).sort();
    expect(kinds).toEqual(["added", "removed"]);
    const added = d.regions.find((r) => r.kind === "added")!;
    expect(regionCentre(added.bbox).x).toBeGreaterThan(200);
    expect(regionCentre(added.bbox).x).toBeLessThan(240);
    expect(d.regions.map((r) => r.id)).toEqual([1, 2]); // ordered top to bottom, 1-based
    expect(d.addedPixels).toBeGreaterThan(0);
    expect(d.removedPixels).toBeGreaterThan(0);
    expect(d.blank).toBe(false);
  });

  it("auto-aligns a revision that is shifted by a few pixels and reports the offset in points", async () => {
    const a = drawing();
    const b = drawing(4, -3);
    const d = await diffRasters({ base: a, revision: b, level: { scale: 2 }, basePage: page, revPage: page }, inThread);
    // the revision has to move by (-4, +3) px = (-2, +1.5) pt to land on the base
    expect(d.offsetPt.x).toBeCloseTo(-2, 0);
    expect(d.offsetPt.y).toBeCloseTo(1.5, 0);
    expect(d.frame).toMatchObject({ s: 1, ox: d.offsetPt.x, oy: d.offsetPt.y });
    expect(d.regions).toHaveLength(0); // identical content once aligned
  });

  it("reports no changes for identical drawings and treats coloured markup as content", async () => {
    const d = await diffRasters({ base: drawing(), revision: drawing(), level, basePage: page, revPage: page }, inThread);
    expect(d.regions).toHaveLength(0);
    expect(d.blank).toBe(false);
    const b = drawing();
    rect(b, 200, 150, 240, 190, [230, 60, 60]); // a red cloud / highlight
    const d2 = await diffRasters({ base: drawing(), revision: b, level, basePage: page, revPage: page }, inThread);
    expect(d2.regions.some((r) => r.kind === "added")).toBe(true);
  });

  it("flags a page-wide change as probably misaligned", async () => {
    const b = blank(320, 240);
    rect(b, 0, 0, 320, 240, [0, 0, 0]);
    const d = await diffRasters({ base: drawing(), revision: b, level, basePage: page, revPage: page }, inThread);
    expect(d.looksMisaligned).toBe(true);
  });

  it("summarises and labels the changes", () => {
    const r = (id: number, kind: "added" | "removed" | "modified") => ({ id, kind, bbox: { x: 0, y: 0, w: 1, h: 1 }, diffPixels: 1, addedPixels: 0, removedPixels: 0 });
    expect(summarizeChanges([r(1, "added"), r(2, "added"), r(3, "removed"), r(4, "modified")])).toEqual({ total: 4, added: 2, removed: 1, modified: 1 });
    expect(changeLabel(r(1, "removed"))).toBe("Removed");
  });
});

describe("viewForBox", () => {
  it("centres a change in the viewport and never zooms past the limit", () => {
    const v = viewForBox({ x: 100, y: 200, w: 50, h: 30 }, { width: 800, height: 600 }, 4);
    expect(v.zoom).toBe(4);
    expect(v.tx + 125 * v.zoom).toBeCloseTo(400);
    expect(v.ty + 215 * v.zoom).toBeCloseTo(300);
    const wide = viewForBox({ x: 0, y: 0, w: 1000, h: 100 }, { width: 800, height: 600 }, 4);
    expect(wide.zoom).toBeCloseTo(800 / 2200);
  });
});
