import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  arrowPath,
  bboxCentre,
  cloudPath,
  cloudScallop,
  computeBBox,
  decimate,
  decodeShape,
  distanceToShape,
  encodeShape,
  hitTest,
  markupPath,
  pagePtToUv,
  roundUv,
  simplifyRdp,
  simplifyToLimit,
  smoothPath,
  strokeFor,
  strokePx,
  textBox,
  translateBBox,
  translateShape,
  uvToPagePt,
  WIDTH_PRESETS,
  type HitCandidate,
} from "./geometry";
import { MARKUP_COLOURS } from "./palette";

const PAGE = { width: 1000, height: 500 };

describe("uv transforms", () => {
  it("round-trips page <-> uv on a non-square page", () => {
    const uv: [number, number] = [0.25, 0.8];
    const p = uvToPagePt(uv, PAGE);
    expect(p).toEqual({ x: 250, y: 400 });
    expect(pagePtToUv(p, PAGE)).toEqual(uv);
  });
  it("rounds to 5 decimals", () => {
    expect(roundUv(0.123456789)).toBe(0.12346);
  });
  it("encode/decode round-trips and quantises", () => {
    const json = encodeShape({ pts: [[0.1234567, 0.2], [0.5, 0.6]], text: "hi", size: 0.0123456 });
    expect(decodeShape(json)).toEqual({ pts: [[0.12346, 0.2], [0.5, 0.6]], text: "hi", size: 0.01235 });
  });
  it("decode rejects malformed docs instead of throwing", () => {
    expect(decodeShape("not json")).toBeNull();
    expect(decodeShape('{"pts":[[1]]}')).toBeNull();
    expect(decodeShape('{"pts":"x"}')).toBeNull();
    expect(decodeShape('{"pts":[[0,null]]}')).toBeNull();
  });
});

describe("simplification (Ramer-Douglas-Peucker)", () => {
  const line = Array.from({ length: 200 }, (_, i) => ({ x: i, y: i * 0.001 })); // nearly straight
  it("collapses a near-straight stroke to its end points", () => {
    expect(simplifyRdp(line, 0.5)).toEqual([line[0], line[199]]);
  });
  it("keeps a real corner", () => {
    const l = [...Array.from({ length: 50 }, (_, i) => ({ x: i, y: 0 })), ...Array.from({ length: 50 }, (_, i) => ({ x: 49, y: i + 1 }))];
    const s = simplifyRdp(l, 0.5);
    expect(s.length).toBe(3);
    expect(s[1]).toEqual({ x: 49, y: 0 });
  });
  it("never moves the ends and never adds points", () => {
    const noisy = Array.from({ length: 300 }, (_, i) => ({ x: i, y: Math.sin(i / 10) * 20 + ((i * 7919) % 5) }));
    const s = simplifyRdp(noisy, 1);
    expect(s[0]).toBe(noisy[0]);
    expect(s[s.length - 1]).toBe(noisy[299]);
    expect(s.length).toBeLessThan(noisy.length);
  });
  it("error stays within the tolerance", () => {
    const wave = Array.from({ length: 400 }, (_, i) => ({ x: i, y: Math.sin(i / 20) * 30 }));
    const tol = 1.5;
    const s = simplifyRdp(wave, tol);
    // every original point is within tol of the simplified polyline
    for (const p of wave) {
      let d = Infinity;
      for (let i = 0; i + 1 < s.length; i++) {
        const a = s[i];
        const b = s[i + 1];
        const len2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
        const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / len2));
        d = Math.min(d, Math.hypot(p.x - (a.x + t * (b.x - a.x)), p.y - (a.y + t * (b.y - a.y))));
      }
      expect(d).toBeLessThanOrEqual(tol + 1e-9);
    }
  });
  it("handles tiny inputs and does not overflow the stack on a huge stroke", () => {
    expect(simplifyRdp([], 1)).toEqual([]);
    expect(simplifyRdp([{ x: 1, y: 1 }], 1)).toEqual([{ x: 1, y: 1 }]);
    const huge = Array.from({ length: 6000 }, (_, i) => ({ x: i, y: (i % 2) * 3 }));
    expect(() => simplifyRdp(huge, 0.1)).not.toThrow();
  });
  it("simplifyToLimit widens the tolerance until the point cap holds", () => {
    const wave = Array.from({ length: 2000 }, (_, i) => ({ x: i, y: Math.sin(i / 5) * 40 + ((i * 31) % 7) }));
    const s = simplifyToLimit(wave, 0.01, 100);
    expect(s.length).toBeLessThanOrEqual(100);
    expect(s[0]).toBe(wave[0]);
  });
  it("decimate drops samples closer than the minimum distance but keeps the last", () => {
    const pts = [0, 0.5, 1, 1.5, 2, 5].map((x) => ({ x, y: 0 }));
    expect(decimate(pts, 1).map((p) => p.x)).toEqual([0, 1, 2, 5]);
    expect(decimate([{ x: 0, y: 0 }, { x: 0.1, y: 0 }], 1).map((p) => p.x)).toEqual([0, 0.1]);
  });
});

describe("bounding boxes and centre", () => {
  it("bbox of a polyline and of corners", () => {
    expect(computeBBox("pen", { pts: [[0.2, 0.5], [0.1, 0.7], [0.4, 0.3]] }, PAGE)).toEqual([0.1, 0.3, 0.4, 0.7]);
    expect(computeBBox("rect", { pts: [[0.6, 0.2], [0.3, 0.4]] }, PAGE)).toEqual([0.3, 0.2, 0.6, 0.4]);
  });
  it("text bbox follows size, lines and the page aspect", () => {
    const shape = { pts: [[0.1, 0.1]] as [number, number][], text: "ab\nabcd", size: 0.02 };
    const b = textBox(shape, PAGE);
    expect(b.x).toBe(100);
    expect(b.y).toBe(50);
    expect(b.h).toBeCloseTo(2 * 20 * 1.25);
    expect(b.w).toBeCloseTo(4 * 20 * 0.58);
    const bb = computeBBox("text", shape, PAGE);
    expect(bb[0]).toBe(0.1);
    expect(bb[2]).toBeGreaterThan(0.1);
    expect(bb[3]).toBeGreaterThan(0.1);
  });
  it("centre of a bbox", () => {
    const c = bboxCentre([0.2, 0.2, 0.6, 0.4]);
    expect(c[0]).toBeCloseTo(0.4);
    expect(c[1]).toBeCloseTo(0.3);
  });
});

describe("move", () => {
  it("translates every point", () => {
    const r = translateShape({ pts: [[0.2, 0.2], [0.3, 0.4]] }, [0.2, 0.2, 0.3, 0.4], 0.1, -0.05);
    expect(r.shape.pts[0][0]).toBeCloseTo(0.3);
    expect(r.shape.pts[1][1]).toBeCloseTo(0.35);
    expect([r.du, r.dv]).toEqual([0.1, -0.05]);
  });
  it("clamps so the box stays on the page", () => {
    const r = translateShape({ pts: [[0.8, 0.8], [0.9, 0.9]] }, [0.8, 0.8, 0.9, 0.9], 0.5, 0.5);
    expect(r.du).toBeCloseTo(0.1);
    expect(r.dv).toBeCloseTo(0.1);
    const l = translateShape({ pts: [[0.1, 0.1], [0.2, 0.2]] }, [0.1, 0.1, 0.2, 0.2], -0.5, -0.5);
    expect(l.du).toBeCloseTo(-0.1);
  });
  it("translateBBox shifts the box", () => {
    translateBBox([0.1, 0.1, 0.2, 0.2], 0.1, 0.2).forEach((n, i) => expect(n).toBeCloseTo([0.2, 0.3, 0.3, 0.4][i]));
  });
});

const item = (id: string, kind: HitCandidate["kind"], pts: [number, number][], over: Partial<HitCandidate> = {}): HitCandidate => ({
  id, kind, shape: { pts }, strokeWidth: 0.002, createdAt: 1, ...over,
});

describe("hit testing", () => {
  const pen = item("pen", "pen", [[0.1, 0.1], [0.5, 0.1]]);
  const rect = item("rect", "rect", [[0.2, 0.4], [0.6, 0.8]]);
  const ell = item("ell", "ellipse", [[0.6, 0.4], [0.9, 0.9]]);
  const arrow = item("arrow", "arrow", [[0.05, 0.9], [0.3, 0.95]]);
  const text = item("text", "text", [[0.7, 0.1]], { shape: { pts: [[0.7, 0.1]], text: "Fix here", size: 0.02 } });
  const all = [pen, rect, ell, arrow, text];
  const at = (u: number, v: number) => uvToPagePt([u, v], PAGE);

  it("hits a stroke within the tolerance and misses beyond it", () => {
    expect(hitTest(all, at(0.3, 0.1), 5, PAGE)).toBe("pen");
    expect(hitTest(all, at(0.3, 0.1 + 4 / 500), 5, PAGE)).toBe("pen");
    expect(hitTest(all, at(0.3, 0.1 + 30 / 500), 5, PAGE)).toBeNull();
  });
  it("hits a rectangle on its outline, not in its empty middle", () => {
    expect(hitTest(all, at(0.2, 0.6), 5, PAGE)).toBe("rect");
    expect(hitTest(all, at(0.4, 0.6), 5, PAGE)).toBeNull();
  });
  it("hits an ellipse on its outline", () => {
    expect(hitTest(all, at(0.75, 0.4), 5, PAGE)).toBe("ell");
    expect(hitTest(all, at(0.75, 0.65), 5, PAGE)).toBeNull();
  });
  it("hits an arrow along its shaft", () => {
    expect(hitTest(all, at(0.175, 0.925), 5, PAGE)).toBe("arrow");
  });
  it("hits text anywhere inside its box", () => {
    const b = textBox(text.shape, PAGE);
    expect(hitTest(all, { x: b.x + b.w / 2, y: b.y + b.h / 2 }, 1, PAGE)).toBe("text");
  });
  it("the nearest wins; a tie goes to the newest", () => {
    const a = item("a", "pen", [[0.1, 0.5], [0.9, 0.5]], { createdAt: 1 });
    const b = item("b", "pen", [[0.1, 0.5], [0.9, 0.5]], { createdAt: 2 });
    expect(hitTest([a, b], at(0.5, 0.5), 5, PAGE)).toBe("b");
    const near = item("near", "pen", [[0.1, 0.51], [0.9, 0.51]], { createdAt: 0 });
    expect(hitTest([a, near], at(0.5, 0.51), 20, PAGE)).toBe("near");
  });
  it("subtracts the half stroke width, so a fat highlight is easy to hit", () => {
    const hl = item("hl", "highlight", [[0.1, 0.5], [0.9, 0.5]], { strokeWidth: 0.03 }); // 30 page units wide
    expect(distanceToShape("highlight", hl.shape, hl.strokeWidth, at(0.5, 0.5 + 10 / 500), PAGE)).toBe(0);
  });
  it("a single-point pen is a dot that can be hit", () => {
    const dot = item("dot", "pen", [[0.5, 0.5]]);
    expect(hitTest([dot], at(0.5, 0.5), 3, PAGE)).toBe("dot");
  });
  it("nothing on an empty list", () => {
    expect(hitTest([], at(0.5, 0.5), 50, PAGE)).toBeNull();
  });
});

describe("paths", () => {
  it("smoothPath: dot, line, curve", () => {
    expect(smoothPath([])).toBe("");
    expect(smoothPath([{ x: 1, y: 2 }])).toMatch(/^M1 2l/);
    expect(smoothPath([{ x: 0, y: 0 }, { x: 5, y: 5 }])).toBe("M0 0L5 5");
    const d = smoothPath([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]);
    expect(d).toContain("Q10 0 10 5");
    expect(d.endsWith("L10 10")).toBe(true);
  });
  it("arrow: shaft plus two head strokes ending at the head", () => {
    const d = arrowPath({ x: 0, y: 0 }, { x: 100, y: 0 }, 20);
    expect(d.startsWith("M0 0L100 0")).toBe(true);
    expect((d.match(/M/g) ?? []).length).toBe(2);
    expect((d.match(/L100 0/g) ?? []).length).toBe(2);
  });
  it("arrow with no length is just a point", () => {
    expect(arrowPath({ x: 1, y: 1 }, { x: 1, y: 1 }, 20)).toBe("M1 1L1 1");
  });
  it("markupPath: nothing for text or a too-short shape", () => {
    expect(markupPath("text", { pts: [[0.1, 0.1]], text: "x" }, 0.003, PAGE)).toBe("");
    expect(markupPath("arrow", { pts: [[0.1, 0.1]] }, 0.003, PAGE)).toBe("");
    expect(markupPath("rect", { pts: [[0.1, 0.1], [0.5, 0.5]] }, 0.003, PAGE)).toMatch(/^M.*Z$/);
    expect(markupPath("ellipse", { pts: [[0.1, 0.1], [0.5, 0.5]] }, 0.003, PAGE)).toContain("A");
  });
});

describe("revision cloud", () => {
  const a = { x: 0, y: 0 };
  const b = { x: 200, y: 100 };
  it("is a closed loop of outward arcs on every edge", () => {
    const d = cloudPath(a, b, 25);
    expect(d.startsWith("M0 0")).toBe(true);
    expect(d.endsWith("Z")).toBe(true);
    const arcs = d.match(/A[^A-Z]+/g) ?? [];
    // 200/25 = 8 arcs on each long edge, 100/25 = 4 on each short one
    expect(arcs.length).toBe(8 + 4 + 8 + 4);
    for (const arc of arcs) expect(arc).toMatch(/^A[\d.]+ [\d.]+ 0 0 1 /); // sweep 1 = outward for the clockwise walk
  });
  it("walks the perimeter and returns to the start", () => {
    const d = cloudPath(a, b, 25);
    const ends = [...d.matchAll(/ 0 0 1 (-?[\d.]+) (-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
    expect(ends[7]).toEqual([200, 0]); // top-right corner after 8 arcs
    expect(ends[11]).toEqual([200, 100]);
    expect(ends[19]).toEqual([0, 100]);
    expect(ends[ends.length - 1]).toEqual([0, 0]);
  });
  it("arc radius is half the chord", () => {
    const d = cloudPath(a, b, 25);
    expect(d).toContain("A12.5 12.5 0 0 1 25 0");
  });
  it("at least two arcs per edge even for a tiny scallop request", () => {
    const d = cloudPath({ x: 0, y: 0 }, { x: 10, y: 10 }, 100);
    expect((d.match(/A/g) ?? []).length).toBe(8);
  });
  it("is independent of the corner order", () => {
    expect(cloudPath(b, a, 25)).toBe(cloudPath(a, b, 25));
  });
  it("a degenerate box falls back to a plain rectangle path", () => {
    expect(cloudPath({ x: 0, y: 0 }, { x: 0, y: 50 }, 10)).toMatch(/^M0 0L/);
  });
  it("the scallop is clamped to a readable size", () => {
    expect(cloudScallop({ x: 0, y: 0 }, { x: 5, y: 5 }, PAGE)).toBeCloseTo(12);
    expect(cloudScallop({ x: 0, y: 0 }, { x: 900, y: 450 }, PAGE)).toBeCloseTo(40);
    expect(cloudScallop({ x: 0, y: 0 }, { x: 400, y: 200 }, PAGE)).toBeCloseTo(40);
    expect(cloudScallop({ x: 0, y: 0 }, { x: 200, y: 100 }, PAGE)).toBeCloseTo(25);
  });
});

describe("styling", () => {
  it("strokePx scales with zoom but never goes below a hairline", () => {
    expect(strokePx(0.003, PAGE, 1)).toBe(3);
    expect(strokePx(0.003, PAGE, 4)).toBe(12);
    expect(strokePx(0.003, PAGE, 0.1)).toBe(1.5);
  });
  it("the highlighter is a wide marker, the others use the preset as is", () => {
    const medium = WIDTH_PRESETS[1];
    expect(strokeFor("pen", medium)).toBe(0.003);
    expect(strokeFor("highlight", medium)).toBeCloseTo(0.015);
    for (const p of WIDTH_PRESETS) expect(strokeFor("highlight", p)).toBeLessThanOrEqual(0.1); // the rules' cap
  });
  it("palette colours are valid doc colours and match the web tokens", () => {
    const css = readFileSync(join(__dirname, "../../../../vendor/free-field/apps/settings/src/styles/tokens.css"), "utf8");
    for (const c of MARKUP_COLOURS) {
      expect(c.hex).toMatch(/^#[0-9a-f]{6}$/);
      const m = new RegExp(`${c.token}:\\s*(#[0-9a-fA-F]{6})`).exec(css);
      expect(m?.[1].toLowerCase(), c.token).toBe(c.hex);
    }
  });
});
