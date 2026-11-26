import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { BlobStore } from "../../storage";
import { cssVar } from "../../theme";
import type { PlanManifest } from "../manifest";
import { TileCache } from "../tileCache";
import { flingStep, releaseVelocity, type FlingSample } from "../fling";
import { clampView, fitView, resizeView, visiblePageRect, zoomAbout, zoomLimits, type View } from "../viewMath";
import type { CompareDiff } from "./diff";
import { ADDED_COLOR, drawRegions, drawSideTiles, REMOVED_COLOR, tintLayer, viewForBox, type CompareMode } from "./drawCompare";
import { IDENTITY_FRAME } from "./geometry";

export interface CompareViewProps {
  store: BlobStore;
  base: { manifest: PlanManifest; label: string };
  revision: { manifest: PlanManifest; label: string };
  diff: CompareDiff;
  mode: CompareMode;
  /** Region to highlight; a changed `focusNonce` flies the view to it. */
  selectedId: number | null;
  focusNonce: number;
  onSelectRegion: (id: number | null) => void;
}

const MAX_DPR = 1.5; // two full-size canvases: keep the GPU memory of a 3.5 GB tablet in check
const COMPARE_TILE_BUDGET = 32 * 1024 * 1024; // per revision
const TAP_SLOP = 10;
const DOUBLE_TAP_MS = 350;
const DOUBLE_TAP_DIST = 48;

/**
 * Touch compare of two revisions on the tile pyramid. ONE view (zoom and pan) drives both revisions, so pinch
 * and pan can never drift apart; the revisions are composited by the 2D canvas (GPU blend modes), no pixel loops
 * and no full-page raster are kept after the diff. Modes: overlay (two colours), swipe (divider), changes (clouds).
 */
export function CompareView({ store, base, revision, diff, mode, selectedId, focusNonce, onSelectRegion }: CompareViewProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scratchRef = useRef<HTMLCanvasElement | null>(null);
  const page = useMemo(() => ({ width: base.manifest.pageWidth, height: base.manifest.pageHeight }), [base.manifest]);
  const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);

  const sizeRef = useRef({ width: 0, height: 0 });
  const viewRef = useRef<View | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [stats, setStats] = useState({ base: 0, rev: 0, level: 0 });
  const [split, setSplitState] = useState(0.5);
  const splitRef = useRef(0.5);
  const rafRef = useRef(0);
  const animRef = useRef(0);
  const scheduleRef = useRef<() => void>(() => undefined);
  const caches = useRef<{ base: TileCache; rev: TileCache } | null>(null);
  const live = useRef({ mode, diff, selectedId, base, revision });
  live.current = { mode, diff, selectedId, base, revision };

  const limits = useCallback(() => {
    const finest = base.manifest.levels[base.manifest.levels.length - 1];
    return zoomLimits(page, sizeRef.current, 0, (finest.scale * 2) / dpr);
  }, [base.manifest, page, dpr]);

  const commit = useCallback(
    (next: View) => {
      const clamped = clampView(next, page, sizeRef.current);
      viewRef.current = clamped;
      setView(clamped);
      scheduleRef.current();
    },
    [page],
  );

  useEffect(() => {
    const c = {
      base: new TileCache(store, base.manifest.planVersionId, () => scheduleRef.current(), COMPARE_TILE_BUDGET),
      rev: new TileCache(store, revision.manifest.planVersionId, () => scheduleRef.current(), COMPARE_TILE_BUDGET),
    };
    caches.current = c;
    scheduleRef.current();
    return () => {
      c.base.dispose();
      c.rev.dispose();
      caches.current = null;
    };
  }, [store, base.manifest.planVersionId, revision.manifest.planVersionId]);

  const draw = useCallback(() => {
    rafRef.current = 0;
    const canvas = canvasRef.current;
    const c = caches.current;
    const v = viewRef.current;
    const sz = sizeRef.current;
    if (!canvas || !c || !v || sz.width === 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const cw = Math.round(sz.width * dpr);
    const ch = Math.round(sz.height * dpr);
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
    }
    const { mode: m, diff: d, selectedId: sel, base: b, revision: r } = live.current;
    const k = v.zoom * dpr;
    const bg = cssVar("--ff-bg-canvas", "#f2f3f4");
    const paper = cssVar("--ff-bg-app", "#ffffff");
    const vis = visiblePageRect(v, page, sz, 96);
    const baseSide = { manifest: b.manifest, cache: c.base, frame: IDENTITY_FRAME };
    const revSide = { manifest: r.manifest, cache: c.rev, frame: d.frame };
    const toDevice = (x: CanvasRenderingContext2D) => x.setTransform(k, 0, 0, k, v.tx * dpr, v.ty * dpr);
    let sb = { drawn: 0, level: 0 };
    let sr = { drawn: 0, level: 0 };

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    if (m === "overlay") {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, cw, ch);
      toDevice(ctx);
      sb = drawSideTiles(ctx, baseSide, vis, k, paper);
      tintLayer(ctx, cw, ch, REMOVED_COLOR);
      let scratch = scratchRef.current;
      if (!scratch) scratch = scratchRef.current = document.createElement("canvas");
      if (scratch.width !== cw || scratch.height !== ch) {
        scratch.width = cw;
        scratch.height = ch;
      }
      const sctx = scratch.getContext("2d");
      if (sctx) {
        sctx.setTransform(1, 0, 0, 1, 0, 0);
        sctx.fillStyle = "#ffffff";
        sctx.fillRect(0, 0, cw, ch);
        toDevice(sctx);
        sr = drawSideTiles(sctx, revSide, vis, k, paper);
        tintLayer(sctx, cw, ch, ADDED_COLOR);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalCompositeOperation = "multiply";
        ctx.drawImage(scratch, 0, 0);
        ctx.globalCompositeOperation = "source-over";
      }
    } else if (m === "swipe") {
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, cw, ch);
      const x = Math.round(splitRef.current * cw);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, x, ch);
      ctx.clip();
      toDevice(ctx);
      sb = drawSideTiles(ctx, baseSide, vis, k, paper);
      ctx.restore();
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, 0, cw - x, ch);
      ctx.clip();
      toDevice(ctx);
      sr = drawSideTiles(ctx, revSide, vis, k, paper);
      ctx.restore();
    } else {
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, cw, ch);
      toDevice(ctx);
      sr = drawSideTiles(ctx, revSide, vis, k, paper);
      drawRegions(ctx, d.regions, sel, k, vis);
    }
    // page border, and the canvas colour around the page (the overlay composite starts from white)
    toDevice(ctx);
    if (m === "overlay") {
      ctx.fillStyle = bg;
      ctx.beginPath();
      ctx.rect(-1e6, -1e6, 2e6 + page.width, 2e6 + page.height);
      ctx.rect(0, 0, page.width, page.height);
      ctx.fill("evenodd");
    }
    ctx.strokeStyle = cssVar("--ff-border", "#e5e7eb");
    ctx.lineWidth = 2 / k;
    ctx.strokeRect(0, 0, page.width, page.height);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    setStats((s) => (s.base === sb.drawn && s.rev === sr.drawn && s.level === Math.max(sb.level, sr.level) ? s : { base: sb.drawn, rev: sr.drawn, level: Math.max(sb.level, sr.level) }));
  }, [dpr, page]);

  useEffect(() => {
    scheduleRef.current = () => {
      if (!rafRef.current) rafRef.current = requestAnimationFrame(draw);
    };
    scheduleRef.current();
  }, [draw, mode, diff, selectedId]);

  useEffect(
    () => () => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      cancelAnimationFrame(animRef.current);
      const s = scratchRef.current;
      if (s) {
        s.width = 0;
        s.height = 0;
      }
    },
    [],
  );

  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const apply = (w: number, h: number) => {
      if (w <= 0 || h <= 0) return;
      const old = sizeRef.current;
      sizeRef.current = { width: w, height: h };
      setSize({ width: w, height: h });
      const v = viewRef.current;
      commit(v && old.width > 0 ? resizeView(v, old, { width: w, height: h }) : fitView(page, { width: w, height: h }, 0, 8));
    };
    const r = el.getBoundingClientRect();
    apply(r.width, r.height);
    const ro = new ResizeObserver((es) => apply(es[0].contentRect.width, es[0].contentRect.height));
    ro.observe(el);
    return () => ro.disconnect();
  }, [page, commit]);

  const animateTo = useCallback(
    (to: View, ms = 260) => {
      const from = viewRef.current;
      if (!from) return;
      cancelAnimationFrame(animRef.current);
      const t0 = performance.now();
      const step = (now: number) => {
        const t = Math.min(1, (now - t0) / ms);
        const e = 1 - (1 - t) * (1 - t);
        const lz = Math.log(from.zoom) + (Math.log(to.zoom) - Math.log(from.zoom)) * e;
        commit({ ...to, zoom: Math.exp(lz), tx: from.tx + (to.tx - from.tx) * e, ty: from.ty + (to.ty - from.ty) * e });
        if (t < 1) animRef.current = requestAnimationFrame(step);
      };
      animRef.current = requestAnimationFrame(step);
    },
    [commit],
  );

  // Fly to the selected change.
  useEffect(() => {
    if (selectedId == null) return;
    const r = diff.regions.find((x) => x.id === selectedId);
    if (!r || sizeRef.current.width === 0) return;
    animateTo(viewForBox(r.bbox, sizeRef.current, Math.min(limits().max, limits().fit * 6)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusNonce]);

  // ── gestures: pan, pinch, double-tap, wheel, fling, tap on a change ─────────────────────────
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ptrs = new Map<number, { x: number; y: number }>();
    let down: { x: number; y: number; t: number; moved: boolean } | null = null;
    let lastTap: { x: number; y: number; t: number } | null = null;
    let pinch: { dist: number; cx: number; cy: number } | null = null;
    let samples: FlingSample[] = [];
    const local = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const stop = () => cancelAnimationFrame(animRef.current);
    const fling = (vel: { vx: number; vy: number }) => {
      stop();
      let last = performance.now();
      let v = vel;
      const step = (now: number) => {
        const dt = Math.min(64, now - last);
        last = now;
        const cur = viewRef.current;
        if (!cur) return;
        const f = flingStep(v, dt);
        commit({ ...cur, tx: cur.tx + f.dx, ty: cur.ty + f.dy });
        v = f.v;
        if (!f.done) animRef.current = requestAnimationFrame(step);
      };
      animRef.current = requestAnimationFrame(step);
    };
    const regionAt = (p: { x: number; y: number }): number | null => {
      const v = viewRef.current;
      if (!v) return null;
      const pt = { x: (p.x - v.tx) / v.zoom, y: (p.y - v.ty) / v.zoom };
      let best: { id: number; area: number } | null = null;
      for (const r of live.current.diff.regions) {
        const b = r.bbox;
        if (pt.x < b.x || pt.y < b.y || pt.x > b.x + b.w || pt.y > b.y + b.h) continue;
        const area = b.w * b.h;
        if (!best || area < best.area) best = { id: r.id, area };
      }
      return best?.id ?? null;
    };

    const onDown = (e: PointerEvent) => {
      if ((e.target as HTMLElement).closest("[data-nogesture]")) return;
      stop();
      samples = [];
      el.setPointerCapture(e.pointerId);
      ptrs.set(e.pointerId, local(e));
      if (ptrs.size === 1) {
        const p = local(e);
        down = { x: p.x, y: p.y, t: e.timeStamp, moved: false };
      } else if (ptrs.size === 2) {
        if (down) down.moved = true;
        const [p, q] = [...ptrs.values()];
        pinch = { dist: Math.hypot(p.x - q.x, p.y - q.y), cx: (p.x + q.x) / 2, cy: (p.y + q.y) / 2 };
      }
    };
    const onMove = (e: PointerEvent) => {
      const prev = ptrs.get(e.pointerId);
      const v = viewRef.current;
      if (!prev || !v) return;
      const cur = local(e);
      ptrs.set(e.pointerId, cur);
      if (ptrs.size === 1) {
        if (down && !down.moved && Math.hypot(cur.x - down.x, cur.y - down.y) > TAP_SLOP) down.moved = true;
        if (down?.moved) {
          commit({ ...v, tx: v.tx + cur.x - prev.x, ty: v.ty + cur.y - prev.y });
          const r = el.getBoundingClientRect();
          const co = e.getCoalescedEvents?.() ?? [];
          for (const c of co.length ? co : [e]) samples.push({ x: c.clientX - r.left, y: c.clientY - r.top, t: c.timeStamp });
          if (samples.length > 24) samples.splice(0, samples.length - 24);
        }
      } else if (ptrs.size === 2 && pinch) {
        const [p, q] = [...ptrs.values()];
        const dist = Math.hypot(p.x - q.x, p.y - q.y);
        const cx = (p.x + q.x) / 2;
        const cy = (p.y + q.y) / 2;
        const lim = limits();
        let next = pinch.dist > 0 ? zoomAbout(v, dist / pinch.dist, { x: pinch.cx, y: pinch.cy }, lim.min, lim.max) : v;
        next = { ...next, tx: next.tx + cx - pinch.cx, ty: next.ty + cy - pinch.cy };
        pinch = { dist, cx, cy };
        commit(next);
      }
    };
    const onUp = (e: PointerEvent) => {
      if (!ptrs.has(e.pointerId)) return;
      ptrs.delete(e.pointerId);
      if (ptrs.size < 2) pinch = null;
      if (ptrs.size === 0 && down) {
        const now = e.timeStamp;
        if (down.moved && e.type === "pointerup") {
          const vel = releaseVelocity(samples, now);
          if (vel.vx !== 0 || vel.vy !== 0) fling(vel);
        }
        samples = [];
        const wasTap = !down.moved && now - down.t < 350 && e.type === "pointerup";
        if (!wasTap) lastTap = null;
        else if (lastTap && now - lastTap.t < DOUBLE_TAP_MS && Math.hypot(lastTap.x - down.x, lastTap.y - down.y) < DOUBLE_TAP_DIST) {
          const v = viewRef.current;
          if (v) {
            const lim = limits();
            animateTo(v.zoom < lim.fit * 1.4 ? zoomAbout(v, 2.5, { x: down.x, y: down.y }, lim.min, lim.max) : fitView(page, sizeRef.current, 0, 8));
          }
          lastTap = null;
        } else {
          lastTap = { x: down.x, y: down.y, t: now };
          if (live.current.mode === "changes") onSelectRegion(regionAt({ x: down.x, y: down.y }));
        }
        down = null;
      } else if (ptrs.size === 1) {
        samples = [];
        if (down) down.moved = true;
      }
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const v = viewRef.current;
      if (!v) return;
      const r = el.getBoundingClientRect();
      const lim = limits();
      commit(zoomAbout(v, Math.exp(-e.deltaY * 0.0015), { x: e.clientX - r.left, y: e.clientY - r.top }, lim.min, lim.max));
    };
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      el.removeEventListener("wheel", onWheel);
    };
  }, [commit, limits, page, animateTo, onSelectRegion]);

  const setSplit = useCallback((f: number) => {
    const c = Math.min(0.96, Math.max(0.04, f));
    splitRef.current = c;
    setSplitState(c);
    scheduleRef.current();
  }, []);

  const handleDrag = useRef<{ id: number } | null>(null);
  const zoomBtn = (f: number) => {
    const v = viewRef.current;
    if (!v) return;
    const lim = limits();
    commit(zoomAbout(v, f, { x: sizeRef.current.width / 2, y: sizeRef.current.height / 2 }, lim.min, lim.max));
  };

  return (
    <div
      ref={rootRef}
      className="plan-viewer cmp-viewer"
      data-testid="compare-viewer"
      data-mode={mode}
      data-zoom={view ? view.zoom.toFixed(4) : ""}
      data-tx={view ? Math.round(view.tx) : ""}
      data-ty={view ? Math.round(view.ty) : ""}
      data-level={stats.level}
      data-drawn-base={stats.base}
      data-drawn-rev={stats.rev}
      data-split={split.toFixed(3)}
    >
      <canvas ref={canvasRef} className="plan-canvas" style={{ width: size.width, height: size.height }} />
      {mode === "swipe" && (
        <>
          <span className="cmp-tag cmp-tag-l" data-testid="compare-tag-base">{base.label}</span>
          <span className="cmp-tag cmp-tag-r" data-testid="compare-tag-rev">{revision.label}</span>
          <div
            className="cmp-divider"
            data-nogesture
            data-testid="compare-divider"
            style={{ left: `${split * 100}%` }}
            role="slider"
            aria-label="Compare divider"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(split * 100)}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              handleDrag.current = { id: e.pointerId };
            }}
            onPointerMove={(e) => {
              if (handleDrag.current?.id !== e.pointerId) return;
              const r = rootRef.current!.getBoundingClientRect();
              setSplit((e.clientX - r.left) / r.width);
            }}
            onPointerUp={() => (handleDrag.current = null)}
            onPointerCancel={() => (handleDrag.current = null)}
          >
            <span className="cmp-divider-knob" aria-hidden>
              ⇔
            </span>
          </div>
        </>
      )}
      {mode === "overlay" && (
        <div className="cmp-legend" data-testid="compare-legend">
          <span><i style={{ background: REMOVED_COLOR }} />Only in {base.label}</span>
          <span><i style={{ background: ADDED_COLOR }} />Only in {revision.label}</span>
          <span><i style={{ background: "#35254a" }} />In both</span>
        </div>
      )}
      <div className="plan-tools" data-nogesture>
        <button type="button" className="btn" data-testid="compare-zoom-in" onClick={() => zoomBtn(1.6)} aria-label="Zoom in">
          +
        </button>
        <button type="button" className="btn" data-testid="compare-zoom-out" onClick={() => zoomBtn(1 / 1.6)} aria-label="Zoom out">
          −
        </button>
        <button type="button" className="btn" data-testid="compare-fit" onClick={() => viewRef.current && commit(fitView(page, sizeRef.current, 0, 8))} aria-label="Fit to screen">
          Fit
        </button>
      </div>
    </div>
  );
}
