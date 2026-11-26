import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { BlobStore } from "../storage";
import { previewKey, type PlanManifest } from "./manifest";
import { DEFAULT_TILE_BUDGET, TileCache, tileId } from "./tileCache";
import { parentTile, selectLevel, tilePageRect, tilesInRect, type ViewHint } from "./tileMath";
import type { PlanPin } from "./pins";
import { pinRevisionBadge } from "./revisions";
import { statusAccent } from "@ff/tasks-react";
import { cssVar } from "../theme";
import { PlanMeasure, type PlanMeasureHandle } from "../measure/PlanMeasure";
import type { PlanMeasureStore } from "../measure/planMeasureStore";
import { PlacementGesture } from "../measure/placement";
import type { Point } from "../measure/webMath";
import { PlanMarker } from "../linkview/PlanMarker";
import type { PagePt, PlanMarker as LinkMarker } from "../linkview/sync";
import { flingStep, releaseVelocity, type FlingSample } from "./fling";
import {
  clampView,
  fitView,
  pageToScreen,
  resizeView,
  rotateView,
  rotMatrix,
  screenToPage,
  screenToUv,
  uvInPage,
  uvToScreen,
  visiblePageRect,
  zoomAbout,
  zoomLimits,
  type View,
} from "./viewMath";

export interface PlanViewerProps {
  manifest: PlanManifest;
  store: BlobStore;
  pins: PlanPin[];
  onPinTap: (pin: PlanPin) => void;
  /** Long-press "New task here" confirmed at this normalized page position. */
  onNewTask: (uv: [number, number]) => void;
  tileBudgetBytes?: number;
  /**
   * Set while the pyramid is still being rendered: the number of tiles written so far. Each change retries the
   * tiles that were missing before and looks for the whole-page preview.
   */
  renderTick?: number;
  /** Reports the visible page rect and zoom (device px per point) so a running render does the visible area first. */
  onViewHint?: (hint: ViewHint) => void;
  /** `performance.now()` of the moment the plan was opened (first-paint timing); defaults to this viewer's mount. */
  openedAt?: number;
  /** Measure tools: the user's measurement store and the plan's calibration scale (metres per page unit). Omit to hide them. */
  measure?: { store: PlanMeasureStore; calibrationMpu: number | null };
  /** Older revision shown read-only: no "New task here" long press. */
  readOnly?: boolean;
  /** Revision number on screen (names it in the stale-pin note). */
  revisionNumber?: number;
  /** Open the revision a stale pin was placed on (offered in its note when that revision is known). */
  onViewRevision?: (versionId: string) => void;
  /**
   * Link view (plan beside the 3D view), opt-in: shows the camera marker, a tap places it (no double-tap zoom, pinch still zooms),
   * the marker's dot and handle move and turn it. Long press still creates a task.
   */
  linkview?: { marker: LinkMarker | null; onPlace: (p: PagePt) => void; onTurn: (heading: number) => void };
}

const LONG_PRESS_MS = 550;
const TAP_SLOP = 10;
const DOUBLE_TAP_MS = 350;
const DOUBLE_TAP_DIST = 48;
const MAX_DPR = 2;


interface Pointer {
  x: number;
  y: number;
}

/**
 * Tile viewer: a 2D canvas draws the visible tiles of the level that matches the
 * zoom (coarser tiles stand in while finer ones load); pins live in a DOM layer on
 * top so hit-testing and accessibility stay native. No live pdf.js here (SPEC A7).
 */
export function PlanViewer({ manifest, store, pins, onPinTap, onNewTask, tileBudgetBytes = DEFAULT_TILE_BUDGET, renderTick, onViewHint, openedAt, measure, linkview, readOnly = false, revisionNumber, onViewRevision }: PlanViewerProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const page = useMemo(() => ({ width: manifest.pageWidth, height: manifest.pageHeight }), [manifest]);
  const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);

  const sizeRef = useRef({ width: 0, height: 0 });
  const viewRef = useRef<View | null>(null);
  const [view, setViewState] = useState<View | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [stats, setStats] = useState({ level: 0, drawn: 0, cached: 0 });
  const mountedAt = useRef(performance.now());
  const previewRef = useRef<ImageBitmap | null>(null);
  const [hasPreview, setHasPreview] = useState(false);
  /** ms from opening the plan until something of the sheet was on screen (preview or first tile), and until the first tile. */
  const [timing, setTiming] = useState<{ paint: number | null; tile: number | null }>({ paint: null, tile: null });
  const hintRef = useRef(onViewHint);
  hintRef.current = onViewHint;
  const [earlier, setEarlier] = useState<PlanPin | null>(null);
  const [anchor, setAnchor] = useState<{ x: number; y: number; uv: [number, number] } | null>(null);
  const rafRef = useRef(0);
  const animRef = useRef(0);
  const measureRef = useRef<PlanMeasureHandle>(null);
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const linkRef = useRef(linkview);
  linkRef.current = linkview;
  const measuringRef = useRef(false);
  const [measuring, setMeasuring] = useState(false);
  const onMeasureActive = useCallback((on: boolean) => {
    measuringRef.current = on;
    setMeasuring(on);
  }, []);

  const cacheRef = useRef<TileCache | null>(null);
  const scheduleRef = useRef<() => void>(() => undefined);

  const limits = useCallback(() => {
    const finest = manifest.levels[manifest.levels.length - 1];
    const v = viewRef.current;
    return zoomLimits(page, sizeRef.current, v?.rot ?? 0, (finest.scale * 2) / dpr);
  }, [manifest, page, dpr]);

  const commit = useCallback(
    (next: View) => {
      const clamped = clampView(next, page, sizeRef.current);
      viewRef.current = clamped;
      setViewState(clamped);
      scheduleRef.current();
    },
    [page],
  );

  // Tile cache lifetime = manifest lifetime.
  useEffect(() => {
    const cache = new TileCache(store, manifest.planVersionId, () => scheduleRef.current(), tileBudgetBytes);
    cacheRef.current = cache;
    return () => {
      cache.dispose();
      cacheRef.current = null;
    };
  }, [store, manifest.planVersionId, tileBudgetBytes]);

  // The whole-page preview (written first by the renderer): a stand-in under every tile until the sharp ones arrive.
  useEffect(() => {
    previewRef.current?.close();
    previewRef.current = null;
    setHasPreview(false);
  }, [store, manifest.planVersionId]);
  useEffect(() => {
    if (previewRef.current || (manifest.complete && renderTick === undefined)) return; // finished pyramids load fast enough without it
    let live = true;
    void (async () => {
      try {
        const bytes = await store.read(previewKey(manifest.planVersionId));
        if (!bytes || !live || previewRef.current) return;
        const bmp = await createImageBitmap(new Blob([bytes as BlobPart], { type: "image/webp" }));
        if (!live || previewRef.current) return bmp.close();
        previewRef.current = bmp;
        setHasPreview(true);
        scheduleRef.current();
      } catch {
        /* no preview (yet): tiles alone */
      }
    })();
    return () => {
      live = false;
    };
  }, [store, manifest.planVersionId, manifest.complete, renderTick]);
  useEffect(
    () => () => {
      previewRef.current?.close();
      previewRef.current = null;
    },
    [],
  );
  // Tiles written since the last look: retry the ones that were missing.
  useEffect(() => {
    cacheRef.current?.resetMisses();
    scheduleRef.current();
  }, [renderTick]);

  const draw = useCallback(() => {
    rafRef.current = 0;
    const canvas = canvasRef.current;
    const cache = cacheRef.current;
    const v = viewRef.current;
    const sz = sizeRef.current;
    if (!canvas || !cache || !v || sz.width === 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const cw = Math.round(sz.width * dpr);
    const ch = Math.round(sz.height * dpr);
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = cssVar("--ff-bg-canvas", "#f2f3f4");
    ctx.fillRect(0, 0, cw, ch);

    const [a, b, c, d] = rotMatrix(v.rot);
    const k = v.zoom * dpr;
    ctx.setTransform(a * k, b * k, c * k, d * k, v.tx * dpr, v.ty * dpr);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.fillStyle = cssVar("--ff-bg-app", "#ffffff"); // paper
    ctx.fillRect(0, 0, page.width, page.height);
    // hairline so white paper reads against the light canvas
    ctx.strokeStyle = cssVar("--ff-border", "#e5e7eb");
    ctx.lineWidth = 2 / k;
    ctx.strokeRect(0, 0, page.width, page.height);
    if (previewRef.current) ctx.drawImage(previewRef.current, 0, 0, page.width, page.height);

    const levels = manifest.levels;
    const level = selectLevel(levels, k);
    const rect = visiblePageRect(v, page, sz, 96);
    const centre = { x: (rect.x0 + rect.x1) / 2, y: (rect.y0 + rect.y1) / 2 };
    const eps = 0.5 / k;
    const wanted: { z: number; x: number; y: number; d: number }[] = [];
    let drawn = 0;
    for (const t of tilesInRect(level, rect)) {
      const r = tilePageRect(level, t.x, t.y);
      const dec = cache.get(tileId(level.z, t.x, t.y));
      if (dec) {
        ctx.drawImage(dec.bitmap, r.x, r.y, r.w + eps, r.h + eps);
        drawn++;
        continue;
      }
      wanted.push({ z: level.z, x: t.x, y: t.y, d: Math.hypot(r.x + r.w / 2 - centre.x, r.y + r.h / 2 - centre.y) });
      // Stand in with the nearest cached ancestor, clipped to this tile.
      let ax = t.x;
      let ay = t.y;
      for (let z = level.z - 1; z >= 0; z--) {
        ({ x: ax, y: ay } = parentTile(ax, ay));
        const anc = cache.peek(tileId(z, ax, ay));
        if (!anc) continue;
        const ar = tilePageRect(levels[z], ax, ay);
        ctx.save();
        ctx.beginPath();
        ctx.rect(r.x, r.y, r.w, r.h);
        ctx.clip();
        ctx.drawImage(anc.bitmap, ar.x, ar.y, ar.w, ar.h);
        ctx.restore();
        break;
      }
    }
    wanted.sort((p, q) => p.d - q.d);
    // Always ask for the coarsest level first: it is the cheap fallback for everything.
    const base = [];
    if (level.z > 0) {
      for (const t of tilesInRect(levels[0], rect)) base.push({ z: 0, x: t.x, y: t.y });
    }
    cache.request([...base, ...wanted]);
    hintRef.current?.({ rect, pxPerPoint: k });
    if (previewRef.current || drawn > 0) {
      const ms = Math.round(performance.now() - (openedAt ?? mountedAt.current));
      setTiming((t) => {
        const paint = t.paint ?? ms;
        const tile = t.tile ?? (drawn > 0 ? ms : null);
        return paint === t.paint && tile === t.tile ? t : { paint, tile };
      });
    }
    setStats((s) => (s.level === level.z && s.drawn === drawn && s.cached === cache.size ? s : { level: level.z, drawn, cached: cache.size }));
  }, [dpr, manifest, page, openedAt]);

  useEffect(() => {
    scheduleRef.current = () => {
      if (!rafRef.current) rafRef.current = requestAnimationFrame(draw);
    };
    scheduleRef.current();
  }, [draw]);

  useEffect(
    () => () => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0; // StrictMode re-mounts: a stale id would block every later schedule
      cancelAnimationFrame(animRef.current);
    },
    [],
  );

  // Container size (also fires on device rotation): keep the page point at the centre.
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
    const ro = new ResizeObserver((es) => {
      const cr = es[0].contentRect;
      apply(cr.width, cr.height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [page, commit]);

  // ── gestures ────────────────────────────────────────────────────────────
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ptrs = new Map<number, Pointer>();
    let down: { x: number; y: number; t: number; moved: boolean } | null = null;
    let lastTap: { x: number; y: number; t: number } | null = null;
    let pinch: { dist: number; cx: number; cy: number } | null = null;
    let pressTimer = 0;
    let samples: FlingSample[] = [];
    // Measure mode: one finger aims and places points, two fingers pan and zoom (PlacementGesture).
    const placement = new PlacementGesture();
    const route = (evs: ReturnType<PlacementGesture["down"]>) => {
      for (const ev of evs) {
        if (ev.type === "aim") measureRef.current?.aim({ x: ev.x, y: ev.y });
        else if (ev.type === "place") measureRef.current?.place({ x: ev.x, y: ev.y });
        else measureRef.current?.aim(null);
      }
    };

    const local = (e: PointerEvent): Pointer => {
      const r = el.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const cancelPress = () => {
      window.clearTimeout(pressTimer);
      pressTimer = 0;
    };
    const stopAnim = () => cancelAnimationFrame(animRef.current);

    const animateTo = (to: View, ms = 220) => {
      const from = viewRef.current;
      if (!from) return;
      stopAnim();
      const t0 = performance.now();
      const step = (now: number) => {
        const t = Math.min(1, (now - t0) / ms);
        const e = 1 - (1 - t) * (1 - t);
        const lz = Math.log(from.zoom) + (Math.log(to.zoom) - Math.log(from.zoom)) * e;
        commit({ ...to, zoom: Math.exp(lz), tx: from.tx + (to.tx - from.tx) * e, ty: from.ty + (to.ty - from.ty) * e });
        if (t < 1) animRef.current = requestAnimationFrame(step);
      };
      animRef.current = requestAnimationFrame(step);
    };

    // Pan inertia: decay the release velocity; a new touch (stopAnim) cancels it.
    const fling = (vel: { vx: number; vy: number }) => {
      stopAnim();
      el.dataset.flings = String(Number(el.dataset.flings ?? 0) + 1); // diagnostics for the e2e spec
      el.dataset.flingSpeed = Math.hypot(vel.vx, vel.vy).toFixed(2);
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

    const onDown = (e: PointerEvent) => {
      if ((e.target as HTMLElement).closest("[data-nogesture]")) return;
      stopAnim();
      samples = [];
      setAnchor(null);
      el.setPointerCapture(e.pointerId);
      ptrs.set(e.pointerId, local(e));
      const measuringNow = measuringRef.current;
      if (measuringNow) route(placement.down(e.pointerId, local(e).x, local(e).y));
      if (ptrs.size === 1 && measuringNow) {
        down = null; // no tap, long press, double tap or pan in measure mode
      } else if (ptrs.size === 1) {
        const p = local(e);
        down = { x: p.x, y: p.y, t: e.timeStamp, moved: false }; // event time, not handler time: a busy main thread must not break double-tap
        if (!readOnlyRef.current) pressTimer = window.setTimeout(() => {
          const v = viewRef.current;
          if (!v || !down || down.moved) return;
          const uv = screenToUv(v, page, { x: down.x, y: down.y });
          if (uvInPage(uv)) {
            navigator.vibrate?.(15);
            setAnchor({ x: down.x, y: down.y, uv });
          }
          down.moved = true; // a long press is not a tap
        }, LONG_PRESS_MS);
      } else if (ptrs.size === 2) {
        cancelPress();
        if (down) down.moved = true;
        const [p, q] = [...ptrs.values()];
        pinch = { dist: Math.hypot(p.x - q.x, p.y - q.y), cx: (p.x + q.x) / 2, cy: (p.y + q.y) / 2 };
      }
    };

    const onMove = (e: PointerEvent) => {
      const prev = ptrs.get(e.pointerId);
      if (!prev) return;
      const cur = local(e);
      ptrs.set(e.pointerId, cur);
      const v = viewRef.current;
      if (!v) return;
      if (measuringRef.current || placement.aiming) route(placement.move(e.pointerId, cur.x, cur.y));
      if (ptrs.size === 1 && (measuringRef.current || placement.aiming)) return;
      if (ptrs.size === 1) {
        if (down && !down.moved && Math.hypot(cur.x - down.x, cur.y - down.y) > TAP_SLOP) {
          down.moved = true;
          cancelPress();
        }
        if (down?.moved) {
          commit({ ...v, tx: v.tx + cur.x - prev.x, ty: v.ty + cur.y - prev.y });
          // Several moves can be coalesced into one event per frame: sample each of them for an accurate release velocity.
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
      route(placement.up(e.pointerId, e.type === "pointercancel"));
      ptrs.delete(e.pointerId);
      cancelPress();
      if (ptrs.size < 2) pinch = null;
      if (ptrs.size === 0 && down) {
        const now = e.timeStamp;
        if (down.moved && e.type === "pointerup") {
          el.dataset.releaseSamples = String(samples.length);
          const vel = releaseVelocity(samples, now);
          if (vel.vx !== 0 || vel.vy !== 0) fling(vel);
        }
        samples = [];
        // In measure mode a tap places a point: two quick taps are two points, never a double-tap zoom.
        const wasTap = !down.moved && now - down.t < 350 && e.type === "pointerup" && !measuringRef.current;
        if (!wasTap) lastTap = null;
        else if (linkRef.current) {
          // Link view: a tap stands the camera there. (No double-tap zoom here: it would move the camera twice.)
          const v = viewRef.current;
          if (v) {
            const pg = screenToPage(v, { x: down.x, y: down.y });
            if (pg.x >= 0 && pg.y >= 0 && pg.x <= page.width && pg.y <= page.height) linkRef.current.onPlace(pg);
          }
          lastTap = null;
        } else {
          if (lastTap && now - lastTap.t < DOUBLE_TAP_MS && Math.hypot(lastTap.x - down.x, lastTap.y - down.y) < DOUBLE_TAP_DIST) {
            const v = viewRef.current;
            if (v) {
              const lim = limits();
              animateTo(v.zoom < lim.fit * 1.4 ? zoomAbout(v, 2.5, { x: down.x, y: down.y }, lim.min, lim.max) : fitView(page, sizeRef.current, v.rot, 8));
            }
            lastTap = null;
          } else lastTap = { x: down.x, y: down.y, t: now };
        }
        down = null;
      } else if (ptrs.size === 1) {
        // Two fingers became one: continue panning from here without a jump.
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
      cancelPress();
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      el.removeEventListener("wheel", onWheel);
    };
  }, [commit, limits, page]);

  const centerOnPage = useCallback(
    (p: Point) => {
      const v = viewRef.current;
      if (!v) return;
      const s = pageToScreen(v, p);
      commit({ ...v, tx: v.tx + sizeRef.current.width / 2 - s.x, ty: v.ty + sizeRef.current.height / 2 - s.y });
    },
    [commit],
  );
  const planCanvas = useCallback(() => canvasRef.current, []);

  // Link view: keep the marker in sight. When the walker leaves the visible area (a walk in the 3D pane) the plan pans to it.
  const marker = linkview?.marker ?? null;
  const mx = marker?.page.x;
  const my = marker?.page.y;
  useEffect(() => {
    const v = viewRef.current;
    const sz = sizeRef.current;
    if (mx === undefined || my === undefined || !v || sz.width === 0) return;
    const s = pageToScreen(v, { x: mx, y: my });
    const inset = 24;
    if (s.x < inset || s.y < inset || s.x > sz.width - inset || s.y > sz.height - inset) centerOnPage({ x: mx, y: my });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mx, my]);

  const toolbar = {
    fit: () => viewRef.current && commit(fitView(page, sizeRef.current, viewRef.current.rot, 8)),
    rotate: () => viewRef.current && commit(rotateView(viewRef.current, 1, sizeRef.current)),
    zoom: (f: number) => {
      const v = viewRef.current;
      if (!v) return;
      const lim = limits();
      commit(zoomAbout(v, f, { x: sizeRef.current.width / 2, y: sizeRef.current.height / 2 }, lim.min, lim.max));
    },
  };

  const visiblePins = view
    ? pins
        .map((p) => ({ p, s: uvToScreen(view, page, p.uv) }))
        .filter(({ s }) => s.x > -40 && s.y > -40 && s.x < size.width + 40 && s.y < size.height + 40)
    : [];
  const anchorScreen = anchor && view ? pageToScreen(view, { x: anchor.uv[0] * page.width, y: anchor.uv[1] * page.height }) : null;

  return (
    <div
      ref={rootRef}
      className="plan-viewer"
      data-testid="plan-viewer"
      data-zoom={view ? view.zoom.toFixed(4) : ""}
      data-tx={view ? Math.round(view.tx) : ""}
      data-ty={view ? Math.round(view.ty) : ""}
      data-rot={view?.rot ?? 0}
      data-level={stats.level}
      data-drawn={stats.drawn}
      data-preview={hasPreview ? "1" : "0"}
      data-first-paint-ms={timing.paint ?? ""}
      data-first-tile-ms={timing.tile ?? ""}
      data-cached={stats.cached}
      data-pins={visiblePins.length}
      data-measuring={measuring ? "1" : "0"}
    >
      <canvas ref={canvasRef} className="plan-canvas" style={{ width: size.width, height: size.height }} />
      <div className="plan-pins" aria-label="Task pins">
        {visiblePins.map(({ p, s }) => (
          <button
            key={p.taskId}
            type="button"
            data-nogesture
            data-testid="plan-pin"
            data-task-id={p.taskId}
            data-revision={p.onEarlierRevision ? "earlier" : "current"}
            className={`plan-pin${p.pending ? " is-pending" : ""}${p.onEarlierRevision ? " is-earlier" : ""}`}
            style={{ transform: `translate(${s.x}px, ${s.y}px)`, ["--pin" as string]: statusAccent(p.status).bg, ["--pin-ink" as string]: statusAccent(p.status).ink }}
            data-revision-number={p.revision.kind === "earlier" ? p.revision.number : undefined}
            aria-label={`Task ${p.num}: ${p.title}${p.revision.kind === "earlier" ? ` (placed on revision ${p.revision.number})` : p.onEarlierRevision ? " (placed on an earlier revision)" : ""}`}
            onClick={() => (p.onEarlierRevision ? setEarlier(p) : onPinTap(p))}
          >
            <span className="plan-pin-dot">{p.num > 0 ? p.num : ""}</span>
            {pinRevisionBadge(p.revision) && (
              <span className="plan-pin-rev" data-testid="plan-pin-rev">
                {pinRevisionBadge(p.revision)}
              </span>
            )}
          </button>
        ))}
        {earlier && (
          <div className="plan-earlier" data-nogesture data-testid="plan-earlier-note" role="dialog" aria-label="Earlier revision pin">
            <p>
              {earlier.revision.kind === "earlier" ? (
                <>
                  <strong>Placed on revision {earlier.revision.number}.</strong> Task {earlier.num > 0 ? `#${earlier.num} ` : ""}was pinned on revision {earlier.revision.number} of this plan
                  {revisionNumber ? `; you are looking at revision ${revisionNumber}` : ""}, so its position may not match this drawing.
                </>
              ) : (
                <>
                  <strong>Placed on an earlier revision.</strong> Task {earlier.num > 0 ? `#${earlier.num} ` : ""}was pinned on{" "}
                  {earlier.pdfVersionId ? "a version of this plan that is no longer available" : "a version that was not recorded"}, so its position may not match this drawing.
                </>
              )}
            </p>
            <div className="row">
              <button type="button" className="btn" data-testid="plan-earlier-dismiss" onClick={() => setEarlier(null)}>
                Close
              </button>
              {earlier.revision.kind === "earlier" && onViewRevision && (
                <button type="button" className="btn" data-testid="plan-earlier-view" onClick={() => onViewRevision((earlier.revision as { versionId: string }).versionId)}>
                  View revision {earlier.revision.number}
                </button>
              )}
              <button type="button" className="btn primary" data-testid="plan-earlier-open" onClick={() => onPinTap(earlier)}>
                Open task
              </button>
            </div>
          </div>
        )}
        {anchor && anchorScreen && (
          <div
            className="plan-anchor"
            data-nogesture
            style={{ transform: `translate(${anchorScreen.x}px, ${anchorScreen.y}px)` }}
          >
            <span className="plan-anchor-mark" />
            <button
              type="button"
              className="btn primary plan-anchor-btn"
              data-testid="plan-new-task"
              onClick={() => onNewTask(anchor.uv)}
            >
              New task here
            </button>
          </div>
        )}
      </div>
      {measure && (
        <PlanMeasure
          ref={measureRef}
          store={measure.store}
          planVersionId={manifest.planVersionId}
          view={view}
          size={size}
          calibrationMpu={measure.calibrationMpu}
          planCanvas={planCanvas}
          centerOn={centerOnPage}
          onActiveChange={onMeasureActive}
        />
      )}
      {linkview?.marker && <PlanMarker view={view} page={page} marker={linkview.marker} onMove={linkview.onPlace} onTurn={linkview.onTurn} />}
      <div className="plan-tools" data-nogesture>
        {linkview?.marker && (
          <button type="button" className="btn" data-testid="plan-find-marker" onClick={() => linkview.marker && centerOnPage(linkview.marker.page)} aria-label="Centre on the camera">
            ◎
          </button>
        )}
        <button type="button" className="btn" data-testid="plan-zoom-in" onClick={() => toolbar.zoom(1.6)} aria-label="Zoom in">
          +
        </button>
        <button type="button" className="btn" data-testid="plan-zoom-out" onClick={() => toolbar.zoom(1 / 1.6)} aria-label="Zoom out">
          −
        </button>
        <button type="button" className="btn" data-testid="plan-fit" onClick={toolbar.fit} aria-label="Fit to screen">
          Fit
        </button>
        <button type="button" className="btn" data-testid="plan-rotate" onClick={toolbar.rotate} aria-label="Rotate plan">
          ⟳
        </button>
      </div>
    </div>
  );
}
