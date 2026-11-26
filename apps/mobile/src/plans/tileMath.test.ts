import { describe, expect, it } from "vitest";
import { adaptivePyramid, parentTile, pickNextUnit, previewSize, type WorkUnit, planLevels, planRegions, selectLevel, TILE_SIZE, tilePageRect, tilePixelRect, tilesInRect, totalTiles } from "./tileMath";

describe("planLevels", () => {
  it("builds 3-5 halving levels, coarsest first", () => {
    for (const [w, h] of [[612, 792], [2384, 1684], [3370, 2384], [100, 100], [20000, 100]]) {
      const ls = planLevels(w, h);
      expect(ls.length).toBeGreaterThanOrEqual(3);
      expect(ls.length).toBeLessThanOrEqual(5);
      for (let i = 1; i < ls.length; i++) expect(ls[i].scale / ls[i - 1].scale).toBeCloseTo(2, 10);
      expect(ls[0].z).toBe(0);
    }
  });

  it("caps the finest level at maxLongSide / maxScale", () => {
    const a0 = planLevels(3370, 2384);
    const fine = a0[a0.length - 1];
    expect(Math.max(fine.width, fine.height)).toBeLessThanOrEqual(6144 + 1);
    const small = planLevels(100, 100);
    expect(small[small.length - 1].scale).toBe(2);
  });

  it("level dimensions and grid cover the page exactly", () => {
    const ls = planLevels(2384, 1684);
    for (const l of ls) {
      expect(l.width).toBe(Math.ceil(2384 * l.scale));
      expect(l.cols).toBe(Math.ceil(l.width / TILE_SIZE));
      expect(l.rows).toBe(Math.ceil(l.height / TILE_SIZE));
    }
    expect(totalTiles(ls)).toBe(ls.reduce((n, l) => n + l.cols * l.rows, 0));
  });

  it("rejects invalid pages", () => {
    expect(() => planLevels(0, 10)).toThrow();
    expect(() => planLevels(10, NaN)).toThrow();
  });
});

describe("tile rects", () => {
  const l = planLevels(1000, 700)[2];
  it("clips edge tiles instead of padding", () => {
    const last = tilePixelRect(l, l.cols - 1, l.rows - 1);
    expect(last.px + last.w).toBe(l.width);
    expect(last.py + last.h).toBe(l.height);
    expect(last.w).toBeLessThanOrEqual(TILE_SIZE);
  });
  it("page rect divides pixel rect by scale", () => {
    const r = tilePageRect(l, 1, 1);
    expect(r.x).toBeCloseTo(TILE_SIZE / l.scale);
    expect(r.w).toBeCloseTo(TILE_SIZE / l.scale);
  });
  it("tilesInRect returns the clamped intersecting tiles", () => {
    const all = tilesInRect(l, { x0: -50, y0: -50, x1: 5000, y1: 5000 });
    expect(all).toHaveLength(l.cols * l.rows);
    const one = tilesInRect(l, { x0: 1, y0: 1, x1: 2, y1: 2 });
    expect(one).toEqual([{ x: 0, y: 0 }]);
    const tsPt = TILE_SIZE / l.scale;
    const straddle = tilesInRect(l, { x0: tsPt - 1, y0: 0, x1: tsPt + 1, y1: 1 });
    expect(straddle.map((t) => t.x)).toEqual([0, 1]);
  });
  it("parentTile halves indices", () => {
    expect(parentTile(5, 3)).toEqual({ x: 2, y: 1 });
  });
});

describe("planRegions", () => {
  const level = planLevels(3370, 2384)[4]; // finest A0 level
  it("never exceeds the pixel cap and tiles the level exactly once", () => {
    for (const cap of [256 * 256, 1_000_000, 8 * 1024 * 1024, 16_000_000]) {
      const regions = planRegions(level, cap);
      const seen = new Set<string>();
      for (const r of regions) {
        expect(r.w * r.h).toBeLessThanOrEqual(cap);
        for (let y = r.ty0; y < r.ty1; y++) for (let x = r.tx0; x < r.tx1; x++) {
          const k = `${x},${y}`;
          expect(seen.has(k)).toBe(false);
          seen.add(k);
        }
      }
      expect(seen.size).toBe(level.cols * level.rows);
    }
  });
  it("uses full-width bands when the width allows", () => {
    const regions = planRegions(level, 8 * 1024 * 1024);
    expect(regions.every((r) => r.tx0 === 0 && r.tx1 === level.cols)).toBe(true);
  });
  it("splits columns when one row of tiles is over the cap", () => {
    const regions = planRegions(level, 4 * 256 * 256);
    expect(regions.every((r) => r.tx1 - r.tx0 <= 4)).toBe(true);
    expect(regions.length).toBeGreaterThan(level.rows);
  });
  it("rejects a cap below one tile", () => {
    expect(() => planRegions(level, 1000)).toThrow();
  });
});

describe("selectLevel", () => {
  const ls = planLevels(2384, 1684);
  it("picks the coarsest level that is sharp enough", () => {
    expect(selectLevel(ls, 0.01).z).toBe(0);
    const l2 = ls[2];
    expect(selectLevel(ls, l2.scale).z).toBe(2);
    // slightly above a level's resolution still accepts it (threshold 0.75)
    expect(selectLevel(ls, l2.scale * 1.2).z).toBe(2);
    expect(selectLevel(ls, l2.scale * 1.5).z).toBe(3);
  });
  it("clamps to the finest level when zoomed past native", () => {
    expect(selectLevel(ls, 100).z).toBe(ls.length - 1);
  });
  it("threshold 1 never picks a soft level", () => {
    const l1 = ls[1];
    expect(selectLevel(ls, l1.scale * 1.01, 1).z).toBe(2);
  });
});

describe("adaptivePyramid", () => {
  it("leaves ordinary sheets alone", () => {
    const a1 = planLevels(2384, 1684, adaptivePyramid(2384, 1684)); // the S-101 sample
    expect(a1).toEqual(planLevels(2384, 1684));
    expect(planLevels(612, 792, adaptivePyramid(612, 792))).toEqual(planLevels(612, 792));
  });
  it("shrinks the finest level of an A0 sheet, with fewer tiles and levels than the default", () => {
    const def = planLevels(3370, 2384);
    const ada = planLevels(3370, 2384, adaptivePyramid(3370, 2384));
    const fine = ada[ada.length - 1];
    expect(fine.width * fine.height).toBeLessThanOrEqual(16_500_000);
    expect(fine.scale).toBeLessThan(def[def.length - 1].scale);
    expect(totalTiles(ada)).toBeLessThan(totalTiles(def) * 0.7);
    expect(ada.length).toBeLessThanOrEqual(def.length);
  });
  it("keeps a usable size for absurd pages and ignores bad input", () => {
    const huge = adaptivePyramid(1_000_000, 1_000_000).maxLongSide!;
    expect(huge).toBeGreaterThanOrEqual(1024);
    expect(huge).toBeLessThanOrEqual(4096);
    expect(adaptivePyramid(0, 10)).toEqual({});
  });
});

describe("pickNextUnit", () => {
  const levels = planLevels(2384, 1684);
  const units: WorkUnit[] = levels.flatMap((level) => planRegions(level, 256 * 256 * 4).map((region) => ({ level, region })));
  const drain = (hint?: Parameters<typeof pickNextUnit>[1]) => {
    const left = [...units];
    const out: WorkUnit[] = [];
    while (left.length) out.push(left.splice(pickNextUnit(left, hint, levels), 1)[0]);
    return out;
  };

  it("without a hint it is coarse to fine in the original order", () => {
    expect(drain()).toEqual(units);
    expect(pickNextUnit([])).toBe(-1);
  });

  it("level 0 first, then the visible regions of the level the zoom shows, nearest to the centre first", () => {
    const target = levels[levels.length - 1];
    const rect = { x0: 100, y0: 100, x1: 500, y1: 400 };
    const order = drain({ rect, pxPerPoint: target.scale });
    const nL0 = units.filter((u) => u.level.z === 0).length;
    expect(order.slice(0, nL0).every((u) => u.level.z === 0)).toBe(true);
    const visible = order.filter((u) => u.level.z === target.z && u.region.px / target.scale < rect.x1 && (u.region.px + u.region.w) / target.scale > rect.x0 && u.region.py / target.scale < rect.y1 && (u.region.py + u.region.h) / target.scale > rect.y0);
    expect(visible.length).toBeGreaterThan(0);
    // all visible regions of the target level come before any level-1 region
    const firstOther = order.findIndex((u, i) => i >= nL0 && !visible.includes(u));
    expect(order.slice(nL0, nL0 + visible.length).every((u) => visible.includes(u))).toBe(true);
    expect(firstOther).toBe(nL0 + visible.length);
    // everything is still rendered exactly once
    expect(order).toHaveLength(units.length);
  });
});

describe("previewSize", () => {
  it("fits the page into the viewport at device resolution", () => {
    const s = previewSize(2160, 3024, 1200, 800, 2);
    expect(s.height).toBeLessThanOrEqual(1600 + 1);
    expect(s.width / s.height).toBeCloseTo(2160 / 3024, 2);
  });
  it("clamps to a readable minimum and a memory-safe maximum", () => {
    expect(Math.max(previewSize(2000, 1000, 100, 100, 1).width, previewSize(2000, 1000, 100, 100, 1).height)).toBe(800);
    const big = previewSize(2000, 1000, 5000, 5000, 3);
    expect(Math.max(big.width, big.height)).toBe(2048);
  });
});
