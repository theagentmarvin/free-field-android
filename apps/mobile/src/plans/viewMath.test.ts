import { describe, expect, it } from "vitest";
import {
  clampView, fitView, normRot, pageScreenBox, pageToScreen, resizeView, rotateView, screenToPage, screenToUv, uvInPage, uvToScreen, visiblePageRect, zoomAbout, zoomLimits,
  type View,
} from "./viewMath";

const page = { width: 2384, height: 1684 };
const vp = { width: 1280, height: 800 };
const close = (a: { x: number; y: number }, b: { x: number; y: number }) => {
  expect(a.x).toBeCloseTo(b.x, 6);
  expect(a.y).toBeCloseTo(b.y, 6);
};

describe("transforms", () => {
  it("round-trips page <-> screen for every rotation and zoom", () => {
    for (const rot of [0, 1, 2, 3]) {
      for (const zoom of [0.2, 1, 3.7]) {
        const v: View = { zoom, tx: 31.5, ty: -77, rot };
        for (const p of [{ x: 0, y: 0 }, { x: 1200, y: 400 }, { x: 2384, y: 1684 }]) close(screenToPage(v, pageToScreen(v, p)), p);
      }
    }
  });
  it("quarter turn maps the page's right edge to the screen's bottom", () => {
    const v: View = { zoom: 1, tx: 0, ty: 0, rot: 1 };
    close(pageToScreen(v, { x: 10, y: 0 }), { x: 0, y: 10 });
    close(pageToScreen(v, { x: 0, y: 10 }), { x: -10, y: 0 });
  });
  it("normRot wraps", () => {
    expect(normRot(-1)).toBe(3);
    expect(normRot(5)).toBe(1);
  });
});

describe("uv <-> screen (pin coordinates)", () => {
  it("is zoom- and rotation-invariant in uv space", () => {
    const uv: [number, number] = [0.62, 0.42];
    for (const rot of [0, 1, 2, 3]) {
      for (const zoom of [0.3, 1.5, 6]) {
        const v: View = { zoom, tx: 120, ty: 40, rot };
        const s = uvToScreen(v, page, uv);
        const back = screenToUv(v, page, s);
        expect(back[0]).toBeCloseTo(uv[0], 9);
        expect(back[1]).toBeCloseTo(uv[1], 9);
      }
    }
  });
  it("a pin stays on the same page spot while zooming about a point", () => {
    const v0 = fitView(page, vp, 0, 8);
    const at = { x: 400, y: 300 };
    const uvAt = screenToUv(v0, page, at);
    const v1 = zoomAbout(v0, 4, at, 0.01, 100);
    const s1 = uvToScreen(v1, page, uvAt);
    close(s1, at);
  });
  it("uv corners map to the page box corners after rotation", () => {
    const v = fitView(page, vp, 1, 0);
    const box = pageScreenBox(v, page);
    const tl = uvToScreen(v, page, [0, 0]);
    const br = uvToScreen(v, page, [1, 1]);
    // rotating by one quarter turn puts uv (0,0) at the top-right of the box
    expect(tl.x).toBeCloseTo(box.x1, 6);
    expect(tl.y).toBeCloseTo(box.y0, 6);
    expect(br.x).toBeCloseTo(box.x0, 6);
    expect(br.y).toBeCloseTo(box.y1, 6);
  });
  it("uvInPage bounds", () => {
    expect(uvInPage([0, 1])).toBe(true);
    expect(uvInPage([-0.01, 0.5])).toBe(false);
    expect(uvInPage([0.5, 1.01])).toBe(false);
  });
});

describe("fit / clamp / limits", () => {
  it("fit centers the page and fits both axes (all rotations)", () => {
    for (const rot of [0, 1, 2, 3]) {
      const v = fitView(page, vp, rot, 0);
      const box = pageScreenBox(v, page);
      expect(box.x0).toBeGreaterThanOrEqual(-1e-6);
      expect(box.x1).toBeLessThanOrEqual(vp.width + 1e-6);
      expect(box.y0).toBeGreaterThanOrEqual(-1e-6);
      expect(box.y1).toBeLessThanOrEqual(vp.height + 1e-6);
      expect((box.x0 + box.x1) / 2).toBeCloseTo(vp.width / 2, 6);
      expect((box.y0 + box.y1) / 2).toBeCloseTo(vp.height / 2, 6);
    }
  });
  it("clamp recenters a small page and keeps a zoomed page reachable", () => {
    const small: View = { zoom: 0.1, tx: 900, ty: 700, rot: 0 };
    const c = clampView(small, page, vp);
    const box = pageScreenBox(c, page);
    expect((box.x0 + box.x1) / 2).toBeCloseTo(vp.width / 2, 6);
    const big: View = { zoom: 2, tx: 5000, ty: 5000, rot: 0 };
    const cb = clampView(big, page, vp);
    expect(cb.tx).toBeLessThanOrEqual(vp.width * 0.15 + 1e-6);
    expect(cb.ty).toBeLessThanOrEqual(vp.height * 0.15 + 1e-6);
    const far: View = { zoom: 2, tx: -99999, ty: -99999, rot: 0 };
    const cf = clampView(far, page, vp);
    const bf = pageScreenBox(cf, page);
    expect(bf.x1).toBeGreaterThanOrEqual(vp.width * 0.85 - 1e-6);
  });
  it("zoomLimits: min below fit, max never below fit", () => {
    const l = zoomLimits(page, vp, 0, 0.0001);
    expect(l.min).toBeLessThan(l.fit);
    expect(l.max).toBeGreaterThan(l.fit);
  });
  it("zoomAbout clamps", () => {
    const v = fitView(page, vp, 0);
    expect(zoomAbout(v, 1000, { x: 0, y: 0 }, 0.1, 2).zoom).toBe(2);
    expect(zoomAbout(v, 0.0001, { x: 0, y: 0 }, 0.1, 2).zoom).toBe(0.1);
  });
});

describe("device rotation and view rotation", () => {
  it("resize keeps the page point at the centre (portrait <-> landscape)", () => {
    const v0: View = { zoom: 1.3, tx: -400, ty: -150, rot: 0 };
    const c0 = screenToPage(v0, { x: vp.width / 2, y: vp.height / 2 });
    const next = { width: 800, height: 1280 };
    const v1 = resizeView(v0, vp, next);
    close(screenToPage(v1, { x: next.width / 2, y: next.height / 2 }), c0);
    expect(v1.zoom).toBe(v0.zoom);
  });
  it("rotateView keeps the centre fixed", () => {
    const v0: View = { zoom: 1.3, tx: -400, ty: -150, rot: 0 };
    const c0 = screenToPage(v0, { x: vp.width / 2, y: vp.height / 2 });
    const v1 = rotateView(v0, 1, vp);
    expect(v1.rot).toBe(1);
    close(screenToPage(v1, { x: vp.width / 2, y: vp.height / 2 }), c0);
    expect(rotateView(v1, 3, vp).rot).toBe(0);
  });
  it("visiblePageRect is clamped to the page and shrinks with zoom", () => {
    const fit = fitView(page, vp, 0);
    const r = visiblePageRect(fit, page, vp, 50);
    expect(r.x0).toBe(0);
    expect(r.x1).toBe(page.width);
    const zoomed = zoomAbout(fit, 6, { x: 640, y: 400 }, 0.01, 100);
    const rz = visiblePageRect(zoomed, page, vp);
    expect(rz.x1 - rz.x0).toBeLessThan((r.x1 - r.x0) / 4);
    // rotated view: visible rect is still a sane axis-aligned page rect
    const rot = visiblePageRect(fitView(page, vp, 1), page, vp);
    expect(rot.x1 - rot.x0).toBeGreaterThan(0);
    expect(rot.y1).toBeLessThanOrEqual(page.height);
  });
});
