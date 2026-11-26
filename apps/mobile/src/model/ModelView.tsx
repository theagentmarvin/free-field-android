import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { App as CapApp } from "@capacitor/app";
import { formatMeasureValue, IfcViewer, type IfcViewerHandle, type IfcViewerReadyContext, type MeasurementEntry, type MeasureVariant, type ViewerPose } from "@ff/viewer-react";
import { Loupe, LOUPE_SIZE } from "../measure/Loupe";
import { loupeSource } from "../measure/loupe";
import { HOLD_MS, reticleFor, TouchIntent, type TouchIntentEvent } from "../measure/touchIntent";
import { engineItems, Measure3D, type WorkPlane } from "./measure3d";
import { MeasureBar, MeasureSheet } from "./MeasureTools";
import type { TaskPin } from "@ff/tasks-react";
import type { StoreyRecord } from "@ff/types";
import { jsHeapMb, webgl2Info } from "./diagnostics";
import { applyPixelRatio, getRenderer, loseContext, modelsBox, modelsCenter, perModelBoxes, raycastAt, type ElementHit, type Engine } from "./engine";
import { BackgroundGuard, heapPressure } from "./backgroundGuard";
import { DisposalBag, viewerRegistry } from "./lifecycle";
import { OverlayScheduler } from "./overlayScheduler";
import { LongPressGate } from "./longPressGate";
import { TapGate } from "./tapGate";
import { newTaskPathForModel } from "./anchor";
import { PinLayer, type PinLayerHandle } from "./PinLayer";
import { PropertiesSheet } from "./PropertiesSheet";
import { resolveProps, type PropsState } from "./properties";
import { isolationPlan, storeyChips } from "./storeys";
import { ModelIndex } from "./modelIndex";
import { VisibilityController } from "./visibilityController";
import { idsOf, INITIAL_VIS, type IdSets, type VisState } from "./visibility";
import { axisIndex, boxAround, clampBox, diffPlanes, EMPTY_SECTION, rangeBounds, sectionPlanes, setBoxEdge, viewBox, type Axis, type AxisPlane, type SectionState } from "./sectionBox";
import { buildModelTree, type TNode } from "./tree";
import { parseQuery } from "./search";
import { runSearch, type SearchResults, type SearchRow } from "./searchEngine";
import type { ToolPanel } from "./ToolsMenu";
import { SectionPanel } from "./SectionPanel";
import { FiltersSheet, type CategoryRow, type FilterModel } from "./FiltersSheet";
import { FilterSummary } from "./FilterSummary";
import { filterItems, filtersLabel, type FilterKind } from "./filterSummary";
import { loadPrefs, sanitizePrefs, savePrefs } from "./filterPrefs";
import { TreePanel } from "./TreePanel";
import { SearchPanel } from "./SearchPanel";
import { ViewsPanel } from "./ViewsPanel";
import { captureView, defaultName, deleteView, renameView, restorePlan, saveView, useSavedViews, viewpointDb, type SavedView } from "./viewpoints";
import { getFragBlob, type ModelSource } from "./useModelSource";
import { onlyNamed } from "./sourceLogic";
import { memoryTuning } from "./memoryConfig";
import { campusSpec, placeCampus } from "./heavyCampus";
import { progressiveEnabled, useProgressiveFiles } from "./progressive";
import { recordLoadMark, resetLoadMarks } from "./loadMarks";
import { hdPixelRatio, readFrame, SETTLE_MS } from "./hdCapture";
import { getPressure, startPressureMonitor, subscribePressure } from "../recovery/recovery";

const HEAVY_WALK_BYTES = 200 * 1024 * 1024;
const PRESSURE_RANK = { none: 0, low: 1, critical: 2 } as const;
const maxPressure = (a: keyof typeof PRESSURE_RANK, b: keyof typeof PRESSURE_RANK) => (PRESSURE_RANK[a] >= PRESSURE_RANK[b] ? a : b);
import {
  EYE_HEIGHT,
  cappedPixelRatio,
  choosePinView,
  fitPose,
  floorForY,
  walkEntryFloor,
  flyPose,
  lookBy,
  sectionHeight,
  stepWalk,
  walkFromPose,
  walkPose,
  type CameraPose,
  type Vec3,
  type WalkInput,
  type WalkState,
} from "./viewMath";
import { WalkLayer } from "./WalkLayer";
import { WalkLevelPicker } from "./WalkLevelPicker";
import { levelIndexFor, walkLevels, withLevel, type WalkLevel } from "./walkLevels";
import { CameraToolbar } from "./CameraToolbar";
import { toolbarLayout, type ToolbarLayout } from "./toolbarLayout";
import { testHooksEnabled } from "../dev/flag";
import type { LinkContextHandle, LinkviewBinding, LinkWalker } from "../linkview/binding";
import { WalkSplitPlan } from "../linkview/WalkSplitPlan";
import { useLinkData } from "../linkview/useLinkPlans";
import { splitDirection, type SplitDirection } from "../linkview/layout";
import { createWalkerStore, planForWalkLevel } from "./walkSplit";
import "./model.css";

type Phase = "loading" | "ready" | "reloading" | "released" | "failed";
type Ready = Extract<ModelSource, { status: "ready" }>;

interface Picked {
  modelId: string;
  localId: number;
  point: Vec3 | null;
}

interface SessionStats {
  reloads: number;
  contextLosses: number;
  lossTimes: number[];
  loadMs: number | null;
  mountedAt: number;
  peakHeapMb: number | null;
}

export interface ModelDebug {
  state(): Record<string, unknown>;
  pose(): ViewerPose | null;
  pixelRatio(): number | null;
  overlay(): { running: boolean; frames: number; runs: number } | null;
  renderStats(): unknown;
  registry(): ReturnType<typeof viewerRegistry.stats>;
  loseContext(): boolean;
  simulateBackground(ms: number): Promise<void>;
  pinScreen(taskId: string): { x: number; y: number; handle: { x: number; y: number } | null; visible: boolean } | null;
  stage(): { x: number; y: number; w: number; h: number } | null;
  elementAt(clientX: number, clientY: number): Promise<ElementHit | null>;
  heapMb(): number | null;
  /** World box of every loaded model. */
  modelBoxes(): Array<{ modelId: string; min: Vec3; max: Vec3 }>;
  /** Scan the stage on a grid with the raycaster and rank the elements found by thinness (smallest bounding-box side first). */
  /** The engine's own geometry of every 3D measurement (independent of the label text). */
  measureItems(): Array<{ variant: MeasureVariant; points: Vec3[] }>;
  thinCandidates(): Promise<{ modelId: string; localId: number; thickness: number; hits: number; x: number; y: number }[]>;
  /** The engine's fragments models (probes and e2e only). */
  models(): ReadonlyMap<string, unknown>;
  /** Draw calls and triangles of the last rendered frame. */
  drawStats(): { calls: number; triangles: number } | null;
  /** What the 3D tools hold right now (e2e). */
  tools(): {
    panel: string | null;
    section: { box: boolean; planes: number; enginePlanes: Array<{ point: Vec3; normal: Vec3 }> };
    hiddenModels: string[];
    hiddenCategories: string[];
    isolated: boolean;
    storey: boolean;
    xray: boolean;
    hiddenCount: Record<string, { all: boolean; n: number }>;
  };
  /** One element with geometry: ids, GlobalId and name (search e2e). */
  sampleElement(skip?: number): Promise<{ modelId: string; localId: number; guid: string | null; name: string | null } | null>;
  /** Screen position (client CSS px) of the selection's centre. */
  selectionScreen(): Promise<{ x: number; y: number; onScreen: boolean } | null>;
}

declare global {
  interface Window {
    __ffmModelDebug?: ModelDebug;
  }
}

const MODEL_COLORS = ["var(--info)", "var(--ok)", "var(--warn)", "var(--danger)", "var(--accent)"];

const SNAP_LABEL: Record<string, string> = { vertex: "Vertex", edge: "Edge", face: "Face", plane: "On plane" };
const LONG_PRESS_MS = 550;
const LONG_PRESS_SLOP = 10;
const TAP_SLOP = 12;

const toVec = (p: { x: number; y: number; z: number }): Vec3 => [p.x, p.y, p.z];
const xyz = (v: Vec3) => ({ x: v[0], y: v[1], z: v[2] });
const poseOf = (p: ViewerPose | null): CameraPose | null => (p ? { pos: p.pos, target: p.target, fov: p.fov } : null);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function releaseAfterMs(): number {
  try {
    const v = Number(window.localStorage.getItem("ffm.model.releaseAfterMs"));
    if (Number.isFinite(v) && v >= 0 && window.localStorage.getItem("ffm.model.releaseAfterMs") !== null) return v;
  } catch {
    /* storage blocked: default */
  }
  return 20_000;
}

interface Props {
  projectId: string;
  buildingId: string;
  source: Ready;
  storeys: readonly StoreyRecord[];
  pins: readonly TaskPin[];
  focusTaskId: string | null;
  /** the toolbar slot of the page (next to the building picker) where the Filters button lives */
  toolbarSlot?: HTMLElement | null;
  /** Link view (opt-in): first person only, starts at `initial`, reports moves, takes orders through its control. */
  linkview?: LinkviewBinding;
  /** Filled with a reader of the view's storey / position / heading (the Link view's entry from the 3D view). */
  linkContext?: MutableRefObject<LinkContextHandle | null>;
  /**
   * Task markup (opt-in): once every model is in and the camera sits at the task's view, read ONE HD frame and hand it
   * over. The page that asked unmounts this view right after, so the capture never leaves a second viewer alive.
   */
  capture?: TaskCapture;
}

export type TaskCaptureResult = { ok: true; blob: Blob; width: number; height: number } | { ok: false; message: string };
export interface TaskCapture {
  taskId: string;
  onResult(r: TaskCaptureResult): void;
}

/**
 * One building's 3D model: the shared viewer engine plus the mobile controls (orbit, first person, storey
 * isolation, picking, task pins) and the robustness layer (render on demand, pixel-ratio cap, context-loss
 * recovery, background release). Mount exactly one at a time; unmounting disposes everything it created.
 */
export function ModelView({ projectId, buildingId, source, storeys, pins, focusTaskId, toolbarSlot = null, linkview, linkContext, capture }: Props) {
  const navigate = useNavigate();
  const viewerRef = useRef<IfcViewerHandle>(null);
  const linkRef = useRef(linkview);
  linkRef.current = linkview;
  const lastLink = useRef<LinkWalker | null>(linkview?.initial ?? null);
  const engineRef = useRef<Engine | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const modelRef = useRef<HTMLDivElement>(null);
  const pinLayerRef = useRef<PinLayerHandle>(null);
  const schedulerRef = useRef<OverlayScheduler | null>(null);
  const bagRef = useRef<DisposalBag | null>(null);
  const bag = () => (bagRef.current ??= new DisposalBag());
  const releaseRegistryRef = useRef<(() => void) | null>(null);
  const savedPoseRef = useRef<ViewerPose | null>(null);
  const statsRef = useRef<SessionStats>({ reloads: 0, contextLosses: 0, lossTimes: [], loadMs: null, mountedAt: performance.now(), peakHeapMb: null });

  const [epoch, setEpoch] = useState(0);
  const [active, setActive] = useState(true);
  const [phase, setPhase] = useState<Phase>("loading");
  const [loaded, setLoaded] = useState(0);
  const [mode, setMode] = useState<"orbit" | "walk">("orbit");
  const [storeyName, setStoreyName] = useState<string | null>(null);
  const [cut, setCut] = useState(false);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [propsState, setPropsState] = useState<PropsState>({ status: "loading" });
  const [candidate, setCandidate] = useState<Picked | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  // 3D measure tools
  const [measuring, setMeasuring] = useState(false);
  const [variant, setVariant] = useState<MeasureVariant>("length");
  const [entries, setEntries] = useState<MeasurementEntry[]>([]);
  const [placed, setPlaced] = useState(0);
  /** A measuring plane is set (length / area / angle start by tapping the surface they are measured on). */
  const [planeSet, setPlaneSet] = useState(false);
  const workPlane = useRef<WorkPlane | null>(null);
  const [readout, setReadout] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [aim3d, setAim3d] = useState<{ x: number; y: number; fx: number; fy: number } | null>(null);
  const [snapKind, setSnapKind] = useState<string | null>(null);
  const [walkFloor, setWalkFloor] = useState<number | null>(null);
  // Walk split: the plan of the walker's level beside (landscape) or above (portrait) the same 3D canvas.
  const walkerStore = useMemo(createWalkerStore, []);
  const [splitDir, setSplitDir] = useState<SplitDirection>("row");
  const [planPref, setPlanPref] = useState<string | null>(null);
  const linkData = useLinkData(projectId, buildingId, !linkview);
  const [layout, setLayout] = useState<ToolbarLayout>("rail");
  const [measureSheet, setMeasureSheet] = useState(false);
  // 3D tools (Tools menu): section, visibility, model tree, search
  const [menuOpen, setMenuOpen] = useState(false);
  const [panel, setPanel] = useState<ToolPanel | null>(null);
  const [vis, setVis] = useState<VisState>(INITIAL_VIS);
  const [visRev, setVisRev] = useState(0);
  const [section, setSection] = useState<SectionState>(EMPTY_SECTION);
  const [secBounds, setSecBounds] = useState<ReturnType<typeof rangeBounds>>(null);
  const [catRows, setCatRows] = useState<CategoryRow[] | null>(null);
  const [treeRoots, setTreeRoots] = useState<TNode[] | null>(null);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [searchRes, setSearchRes] = useState<SearchResults | null>(null);
  const [searchBusy, setSearchBusy] = useState(false);
  const indexRef = useRef<ModelIndex | null>(null);
  const visRef = useRef<VisibilityController | null>(null);
  const searchToken = useRef(0);
  const measureRef = useRef<Measure3D | null>(null);
  const ctxRef = useRef<IfcViewerReadyContext | null>(null);
  const loupeSrc = useRef<HTMLCanvasElement | null>(null);

  const closePanels = useCallback(() => {
    setPanel(null);
    setMenuOpen(false);
  }, []);
  const openPanel = useCallback((p: ToolPanel) => {
    setMenuOpen(false);
    setMeasureSheet(false);
    setPanel(p);
  }, []);

  const chips = useMemo(() => storeyChips(storeys), [storeys]);
  const elevations = useMemo(() => chips.map((c) => c.elevation), [chips]);

  // Latest values for callbacks that outlive a render (listeners, debug hooks).
  const live = useRef({ phase, loaded, mode, storeyName, picked, epoch, pins, chips, measuring });
  live.current = { phase, loaded, mode, storeyName, picked, epoch, pins, chips, measuring };

  const livePanel = useRef<ToolPanel | null>(null);
  livePanel.current = panel;
  const liveSection = useRef<SectionState>(EMPTY_SECTION);
  liveSection.current = section;

  const longPressGate = useRef(new LongPressGate());
  const tapGate = useRef(new TapGate());
  const kick = useCallback((force = false) => schedulerRef.current?.kick(force), []);

  const noteTap = (t0: number, hit: boolean) => {
    if (testHooksEnabled()) (window as unknown as { __ffmTap?: unknown }).__ffmTap = { via: "raycast", hit, ms: Math.round(performance.now() - t0) };
  };

  const clearPick = useCallback(() => {
    viewerRef.current?.clearSelection();
    if (longPressGate.current.shouldClearCandidate()) setCandidate(null);
    setPicked(null);
  }, []);

  /**
   * Tap decision (see TapGate): the viewer's own click pick is off (`builtInClickPick={false}`), so the visibility-aware
   * fragments raycast, the same one the long-press uses, decides: select that element or clear on empty space.
   */
  const resolveTap = useCallback(
    async (x: number, y: number, token: number) => {
      const t0 = performance.now();
      const hit = await raycastAt(engineRef.current, x, y);
      if (live.current.mode === "walk" || live.current.measuring) return;
      const out = tapGate.current.settle(token, !!hit);
      if (out === "select" && hit) {
        noteTap(t0, true);
        viewerRef.current?.selectElement(hit.modelId, hit.localId);
        setPicked({ modelId: hit.modelId, localId: hit.localId, point: hit.point });
        if (longPressGate.current.shouldClearCandidate()) setCandidate(null);
      } else if (out === "clear") {
        noteTap(t0, false);
        clearPick();
      }
    },
    [clearPick],
  );

  const aspect = () => {
    const s = stageRef.current;
    return s && s.clientHeight > 0 ? s.clientWidth / s.clientHeight : 1.6;
  };

  // ── viewer lifecycle ────────────────────────────────────────────────
  const reload = useCallback((reason: string) => {
    const pose = viewerRef.current?.getPose({ silent: true });
    if (pose) savedPoseRef.current = pose;
    statsRef.current.reloads++;
    console.info(`[model] reloading (${reason})`);
    setPhase("reloading");
    setLoaded(0);
    setMode("orbit");
    // Unmount first and wait until the old world is really gone, then build the new one (never two at once).
    setActive(false);
    void (async () => {
      await sleep(250);
      await viewerRegistry.whenIdle(4000);
      setEpoch((e) => e + 1);
      setActive(true);
    })();
  }, []);

  const onContextLost = useCallback(() => {
    const s = statsRef.current;
    const now = performance.now();
    s.contextLosses++;
    s.lossTimes = [...s.lossTimes.filter((t) => now - t < 60_000), now];
    if (s.lossTimes.length > 3) {
      setPhase("failed"); // a GPU that keeps losing the context: stop thrashing, let the user retry
      return;
    }
    reload("webgl context lost");
  }, [reload]);

  // The viewer's `onReady` hands out the engine objects once per mount; `onDispose` fires right before the world goes.
  const onReady = useCallback(
    (ctx: IfcViewerReadyContext) => {
      engineRef.current = ctx;
      ctxRef.current = ctx;
      const release = (releaseRegistryRef.current ??= viewerRegistry.acquire());
      applyPixelRatio(ctx, cappedPixelRatio(window.devicePixelRatio));
      // The tools' caches and visibility state belong to this viewer instance: a reload starts them over.
      const models = () => ctx.fragments.core.models.list;
      const index = new ModelIndex(models);
      indexRef.current = index;
      visRef.current?.dispose();
      const vc = new VisibilityController({
        viewer: () => viewerRef.current,
        models,
        index,
        onChange: (st) => {
          setVis(st);
          setVisRev((r) => r + 1);
        },
      });
      visRef.current = vc;
      setVis(INITIAL_VIS);
      setStoreyName(null);
      setCut(false);
      setCatRows(null);
      setSecBounds(null);
      const canvas = ctx.renderer.three.domElement;
      const lost = (e: Event) => {
        e.preventDefault(); // lets the browser fire `webglcontextrestored`; we rebuild the world anyway
        onContextLost();
      };
      canvas.addEventListener("webglcontextlost", lost);
      ctx.onDispose(() => {
        canvas.removeEventListener("webglcontextlost", lost);
        if (engineRef.current === ctx) engineRef.current = null;
        if (ctxRef.current === ctx) ctxRef.current = null;
        if (indexRef.current === index) {
          index.dispose();
          indexRef.current = null;
        }
        if (visRef.current === vc) {
          vc.dispose();
          visRef.current = null;
        }
        releaseRegistryRef.current = null;
        // The viewer disposes its models asynchronously: count the session as gone only once they are
        // (the manager's core is an inert empty one after dispose, so this never throws).
        void (async () => {
          for (let i = 0; i < 40 && ctx.fragments.core.models.list.size > 0; i++) await sleep(50);
          release();
        })();
      });
    },
    [onContextLost],
  );

  // The viewer has mounted: wire listeners that need its handle.
  useEffect(() => {
    if (!active) return;
    const v = viewerRef.current;
    if (!v) return;
    const b = bag();
    statsRef.current.mountedAt = performance.now();
    if (testHooksEnabled()) resetLoadMarks();
    const off = v.onLoadedModelsChange((count) => {
      placeCampus(engineRef.current, campusSpec()); // test-only synthetic federation; a no-op in every real build
      if (testHooksEnabled()) recordLoadMark(count, statsRef.current.mountedAt, () => getRenderer(engineRef.current));
      setLoaded(count);
      if (count > 0) {
        setPhase((p) => (p === "loading" || p === "reloading" ? "ready" : p));
        const s = statsRef.current;
        if (s.loadMs === null) s.loadMs = Math.round(performance.now() - s.mountedAt);
        const h = jsHeapMb();
        if (h !== null) s.peakHeapMb = Math.max(s.peakHeapMb ?? 0, h);
      }
    });
    b.add("loadedModelsChange", off);
    let seen = 0;
    v.onMeasurementsChange?.((list) => {
      if (list.length > seen) {
        // the engine completed a measurement: the draft is over
        measureRef.current?.resetDraft();
        setPlaced(0);
        setReadout("");
      }
      seen = list.length;
      setEntries(list);
    });
    setEntries([]);
    return () => {
      try {
        v.onMeasurementsChange?.(null);
      } catch {
        /* viewer already disposed */
      }
      bagRef.current?.dispose();
      bagRef.current = null;
      schedulerRef.current?.dispose();
      schedulerRef.current = null;
    };
  }, [active, epoch]);

  // After a reload/restore: put the camera back once the model is in (the viewer fits the first load itself).
  useEffect(() => {
    if (loaded === 0 || !savedPoseRef.current) return;
    const pose = savedPoseRef.current;
    savedPoseRef.current = null;
    viewerRef.current?.setViewPose(pose, { animate: false });
    kick(true);
  }, [loaded, kick]);

  // ── overlay (pin) scheduler: runs only while the camera moves ───────
  useEffect(() => {
    if (!active || loaded === 0) return;
    const v = viewerRef.current;
    const stage = stageRef.current;
    if (!v || !stage) return;
    const b = bag();
    const sched = new OverlayScheduler({
      raf: (cb) => requestAnimationFrame(cb),
      caf: (id) => cancelAnimationFrame(id),
      revision: () => v.getViewportRevision(),
      onFrame: () => {
        const pose = v.getPose({ silent: true });
        if (pose) pinLayerRef.current?.update(poseOf(pose)!, stage.clientWidth, stage.clientHeight);
      },
    });
    schedulerRef.current = sched;
    const wake = () => sched.kick();
    for (const t of ["pointerdown", "pointermove", "pointerup", "wheel", "touchmove"]) b.addListener(stage, t, wake, { capture: true, passive: true });
    b.addListener(window, "resize", wake);
    // Watchdog: a camera change nobody told us about (programmatic move) is noticed within a second.
    const wd = window.setInterval(() => sched.wakeIfChanged(), 1000);
    b.add("watchdog", () => window.clearInterval(wd));
    b.add("scheduler", () => sched.dispose());
    sched.kick(true);
    return () => {
      if (schedulerRef.current === sched) schedulerRef.current = null;
      sched.dispose();
    };
  }, [active, epoch, loaded > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => kick(true), [pins, kick]);

  // ── properties of the picked element ────────────────────────────────
  useEffect(() => {
    if (!picked) return;
    let cancelled = false;
    setPropsState({ status: "loading" });
    const v = viewerRef.current;
    void (async () => {
      const t0 = performance.now();
      const state = await resolveProps(async () => (await v?.getElementDataWithGuid?.(picked.modelId, picked.localId)) ?? null, `Element ${picked.localId}`);
      if (cancelled) return;
      if (testHooksEnabled()) (window as unknown as { __ffmProps?: unknown }).__ffmProps = { modelId: picked.modelId, localId: picked.localId, status: state.status, reason: state.status === "error" ? state.reason : null, ms: Math.round(performance.now() - t0) };
      setPropsState(state);
    })();
    return () => {
      cancelled = true;
    };
  }, [picked?.modelId, picked?.localId]); // eslint-disable-line react-hooks/exhaustive-deps

  /** The world point of the current selection: real pick point, else the element's centre. */
  const selectionPoint = useCallback(async (): Promise<Vec3 | null> => {
    const v = viewerRef.current;
    if (!v) return null;
    for (let i = 0; i < 30 && v.isSelectionPointPending(); i++) await sleep(50);
    const p = v.getSelectionWorldPoint() ?? (await v.getSelectionWorldCenter());
    return p ? toVec(p) : null;
  }, []);

  const storeyAt = useCallback(
    (y: number | null): string | null => {
      if (live.current.storeyName) return live.current.storeyName;
      if (y === null || chips.length === 0) return null;
      const floor = floorForY(elevations, y);
      return chips.find((c) => c.elevation === floor)?.name ?? null;
    },
    [chips, elevations],
  );

  const newTaskFor = useCallback(
    async (sel: Picked) => {
      const v = viewerRef.current;
      if (!v) return;
      const point = sel.point ?? (live.current.picked && live.current.picked.localId === sel.localId ? await selectionPoint() : null);
      const pose = poseOf(v.getPose({ silent: true }));
      const path = newTaskPathForModel({ modelId: sel.modelId, localId: sel.localId, point, pose }, buildingId, storeyAt(point ? point[1] : null));
      if (path) navigate(path);
    },
    [buildingId, navigate, selectionPoint, storeyAt],
  );

  // ── long press → candidate → "New task here" ────────────────────────
  useEffect(() => {
    if (!active || phase !== "ready" || mode !== "orbit" || measuring) return; // measure mode owns the finger: no select, no long press
    const stage = stageRef.current;
    if (!stage) return;
    let timer: number | null = null;
    let start: { id: number; x: number; y: number } | null = null;
    let tapStart: { id: number; x: number; y: number; t: number } | null = null;
    const cancel = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      start = null;
    };
    const down = (e: PointerEvent) => {
      if (!e.isPrimary) return cancel(); // a second finger: it is a pinch
      if ((e.target as HTMLElement).closest("button, .model-sheet, .model-lp")) return;
      longPressGate.current.newGesture();
      cancel();
      start = { id: e.pointerId, x: e.clientX, y: e.clientY };
      tapStart = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now() };
      const downAt = performance.now();
      timer = window.setTimeout(async () => {
        const s = start;
        cancel();
        if (!s) return;
        const firedAt = performance.now();
        navigator.vibrate?.(12);
        longPressGate.current.fired();
        const perModel: Array<{ modelId: string; ms: number }> = [];
        const hit = await raycastAt(engineRef.current, s.x, s.y, testHooksEnabled() ? perModel : undefined);
        const rayDoneAt = performance.now();
        const v = viewerRef.current;
        let selectMs = 0;
        let pickWorldMs = 0;
        if (hit) {
          const t = performance.now();
          v?.selectElement(hit.modelId, hit.localId);
          selectMs = performance.now() - t;
          setPicked({ modelId: hit.modelId, localId: hit.localId, point: hit.point });
          setCandidate({ modelId: hit.modelId, localId: hit.localId, point: hit.point });
        } else {
          const t = performance.now();
          const wp = await v?.pickWorldPoint(s.x, s.y);
          pickWorldMs = performance.now() - t;
          if (wp) setCandidate({ modelId: "", localId: -1, point: toVec(wp) });
        }
        if (testHooksEnabled()) {
          const candidateSetAt = performance.now();
          // e2e breakdown of the press-to-bar delay (PERF-2); `paintMs` = candidate state set to the next frame
          const rec: Record<string, unknown> = {
            timerLateMs: Math.round(firedAt - downAt - LONG_PRESS_MS),
            raycastMs: Math.round(rayDoneAt - firedAt),
            raycastPerModelMs: perModel,
            selectMs: Math.round(selectMs),
            pickWorldPointMs: Math.round(pickWorldMs),
            hit: !!hit,
          };
          (window as unknown as { __ffmLongPress?: unknown }).__ffmLongPress = rec;
          requestAnimationFrame(() => {
            rec.paintMs = Math.round(performance.now() - candidateSetAt);
          });
        }
      }, LONG_PRESS_MS);
    };
    const move = (e: PointerEvent) => {
      if (tapStart && e.pointerId === tapStart.id && Math.hypot(e.clientX - tapStart.x, e.clientY - tapStart.y) > TAP_SLOP) tapStart = null;
      if (start && e.pointerId === start.id && Math.hypot(e.clientX - start.x, e.clientY - start.y) > LONG_PRESS_SLOP) cancel();
    };
    stage.addEventListener("pointerdown", down, true);
    stage.addEventListener("pointermove", move, true);
    const up = (e: PointerEvent) => {
      // A short press that did not move is a tap: the visibility-aware raycast decides it at once (TapGate); the viewer's own
      // pick only matters after a raycast miss. The long-press timer clears `start` when it fires, so `start` here means "no long-press".
      const ts = tapStart;
      const wasTap = !!ts && !!start && e.pointerId === ts.id && performance.now() - ts.t < LONG_PRESS_MS;
      tapStart = null;
      cancel();
      if (!wasTap || !ts) return;
      void resolveTap(ts.x, ts.y, tapGate.current.begin());
    };
    stage.addEventListener("pointerup", up, true);
    stage.addEventListener("pointercancel", cancel, true);
    return () => {
      cancel();
      stage.removeEventListener("pointerdown", down, true);
      stage.removeEventListener("pointermove", move, true);
      stage.removeEventListener("pointerup", up, true);
      stage.removeEventListener("pointercancel", cancel, true);
    };
  }, [active, phase, mode, epoch, resolveTap, measuring]);

  // Toolbar layout follows the stage shape: a rail on the right edge in landscape, a bar along the bottom in portrait.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const apply = () => setLayout(toolbarLayout({ w: stage.clientWidth, h: stage.clientHeight }));
    apply();
    if (typeof ResizeObserver === "undefined") return;
    // A resized canvas is cleared and the engine renders on demand: ask for frames after the walk split opens or closes (or the device turns).
    const timers: number[] = [];
    const redraw = () => {
      apply();
      kick(true);
      for (const ms of [250, 700]) timers.push(window.setTimeout(() => kick(true), ms));
    };
    const ro = new ResizeObserver(redraw);
    ro.observe(stage);
    return () => {
      ro.disconnect();
      timers.forEach((t) => window.clearTimeout(t));
    };
  }, [kick]);

  // ── measure session ──────────────────────────────────────────────────
  // One finger is a camera control first (TouchIntent): a DRAG orbits, a TAP places a point, a LONG PRESS aims precisely (the
  // reticle sits above the fingertip, a loupe magnifies it, lifting places the point there). Two fingers pan/zoom.
  useEffect(() => {
    if (!measuring || !active || phase !== "ready") return;
    const v = viewerRef.current;
    const ctx = ctxRef.current;
    const stage = stageRef.current;
    if (!v || !ctx || !stage) return;
    v.setMeasureMode("measure", variant);
    const m = new Measure3D(ctx, variant, () => v.requestRender?.("measure-plane"));
    measureRef.current = m;
    if (m.needsPlane && workPlane.current) m.usePlane(workPlane.current);
    setPlaneSet(m.hasPlane);
    setPlaced(0);
    setReadout("");
    v.onMeasureReadout((r) => setReadout(r ? formatMeasureValue(r.value, r.unit) : ""));
    const offPick = m.onPick(() => setSnapKind(m.snapKind()));
    const g = new TouchIntent({ reticle: (x, y) => reticleFor(x, y, stage.getBoundingClientRect()) });
    let holdTimer: number | null = null;
    const stopHold = () => {
      if (holdTimer !== null) window.clearTimeout(holdTimer);
      holdTimer = null;
    };
    const rel = (x: number, y: number) => {
      const r = stage.getBoundingClientRect();
      return { x: x - r.left, y: y - r.top };
    };
    const route = (evs: TouchIntentEvent[]) => {
      for (const ev of evs) {
        if (ev.type === "aim") {
          if (!loupeSrc.current) loupeSrc.current = m.snapshot();
          const a = rel(ev.x, ev.y);
          const f = rel(ev.fx, ev.fy);
          setAim3d({ x: a.x, y: a.y, fx: f.x, fy: f.y });
          m.aim(ev.x, ev.y);
        } else {
          setAim3d(null);
          setSnapKind(null);
          m.releaseSnapshot();
          loupeSrc.current = null;
          if (ev.type === "place" && m.needsPlane && !m.hasPlane) {
            // step 1: the tap picks the surface to measure on
            setNotice(null);
            void m.setPlaneAt(ev.x, ev.y).then((ok) => {
              if (measureRef.current !== m) return; // the session ended (or the variant changed) meanwhile
              workPlane.current = m.exportPlane();
              setPlaneSet(m.hasPlane);
              if (!ok) setNotice("Tap a surface of the model");
            });
          } else if (ev.type === "place") {
            setNotice(null);
            void m.place(ev.x, ev.y).then((ok) => {
              setPlaced(m.count);
              if (!ok) setNotice("Nothing to measure there");
            });
          }
        }
      }
    };
    const onUi = (e: Event) => !!(e.target as HTMLElement).closest("button, .model-sheet, .model-measure-bar, .model-lp, .model-tools");
    const down = (e: PointerEvent) => {
      if (e.pointerId === 4242 || onUi(e)) return;
      longPressGate.current.newGesture();
      route(g.down(e.pointerId, e.clientX, e.clientY));
      // Start the engine's snap pick under the finger at once (no loupe yet): a tap that lifts a moment later finds it ready.
      if (g.phase === "pending") m.aim(e.clientX, e.clientY);
      stopHold();
      if (g.holdArmed) holdTimer = window.setTimeout(() => route(g.hold()), HOLD_MS);
    };
    const move = (e: PointerEvent) => {
      if (e.pointerId === 4242) return;
      route(g.move(e.pointerId, e.clientX, e.clientY));
      if (!g.holdArmed) stopHold();
      // A pending tap and an aim must not nudge the camera; a drag (orbit) and two fingers belong to it.
      if (g.swallowMoves) e.stopPropagation();
    };
    const up = (e: PointerEvent) => {
      if (e.pointerId === 4242) return;
      stopHold();
      route(g.up(e.pointerId, e.type === "pointercancel"));
    };
    // A real tap also makes the browser fire `click` on the canvas, which the viewer would turn into a second point: only our synthetic click counts.
    const canvas = ctx.renderer.three.domElement;
    const noClick = (e: MouseEvent) => {
      if (e.isTrusted && e.target === canvas) e.stopPropagation();
    };
    stage.addEventListener("pointerdown", down, true);
    stage.addEventListener("pointermove", move, true);
    stage.addEventListener("pointerup", up, true);
    stage.addEventListener("pointercancel", up, true);
    stage.addEventListener("click", noClick, true);
    return () => {
      stopHold();
      offPick();
      stage.removeEventListener("pointerdown", down, true);
      stage.removeEventListener("pointermove", move, true);
      stage.removeEventListener("pointerup", up, true);
      stage.removeEventListener("pointercancel", up, true);
      stage.removeEventListener("click", noClick, true);
      try {
        v.onMeasureReadout(null);
        v.setMeasureMode("select");
      } catch {
        /* the viewer is already gone (reload): nothing to disarm */
      }
      m.dispose();
      if (measureRef.current === m) measureRef.current = null;
      loupeSrc.current = null;
      setAim3d(null);
      setSnapKind(null);
      setNotice(null);
      setPlaced(0);
      setReadout("");
    };
  }, [measuring, variant, active, phase, epoch]);

  const startMeasure = useCallback(() => {
    if (live.current.mode === "walk") {
      stopWalkLoop();
      const back = walk.current?.back;
      walk.current = null;
      walkerStore.set(null);
      setMode("orbit");
      setWalkFloor(null);
      if (back) viewerRef.current?.setViewPose(back, { animate: false });
    }
    // The gates: any tap still being resolved must not select, and a pending "New task here" bar goes away.
    tapGate.current.invalidate();
    longPressGate.current.newGesture();
    viewerRef.current?.clearSelection();
    setPicked(null);
    setCandidate(null);
    setMeasureSheet(false);
    closePanels();
    workPlane.current = null; // every measuring session starts by picking its plane
    setPlaneSet(false);
    setMeasuring(true);
  }, [closePanels, walkerStore]);
  const stopMeasure = useCallback(() => setMeasuring(false), []);
  // A new measuring session starts without a plane.
  useEffect(() => {
    if (!measuring) {
      workPlane.current = null;
      setPlaneSet(false);
    }
  }, [measuring]);

  // Leaving the model (reload / background release) ends the session.
  useEffect(() => {
    if (!active || phase === "released" || phase === "reloading") setMeasuring(false);
  }, [active, phase]);

  const measureUndo = () => {
    const m = measureRef.current;
    const v = viewerRef.current;
    if (!m || !v) return;
    void m.undo(() => v.cancelMeasureCreation()).then(() => setPlaced(m.count));
  };
  /** Pick another surface: the measurement being drawn is dropped, the next tap sets the new plane. */
  const measureChangePlane = () => {
    viewerRef.current?.cancelMeasureCreation();
    const m = measureRef.current;
    m?.resetDraft();
    m?.clearPlane();
    workPlane.current = null;
    setPlaneSet(false);
    setPlaced(0);
    setNotice(null);
  };
  const measureFinish = () => {
    viewerRef.current?.finishMeasureCreation?.();
    measureRef.current?.resetDraft();
    setPlaced(0);
  };
  const measureCancel = () => {
    viewerRef.current?.cancelMeasureCreation();
    measureRef.current?.resetDraft();
    setPlaced(0);
    setReadout("");
  };

  // ── camera commands ─────────────────────────────────────────────────

  const fit = useCallback(() => {
    const v = viewerRef.current;
    const box = modelsBox(engineRef.current);
    const cur = v?.getPose({ silent: true });
    if (!v || !box) return;
    v.setViewPose({ ...fitPose(box, cur?.fov ?? 45, aspect()), isOrtho: false }, { animate: true });
    kick();
  }, [kick]);

  const chooseStorey = useCallback(
    async (name: string | null, withCut: boolean) => {
      const v = viewerRef.current;
      const vc = visRef.current;
      if (!v || !vc) return;
      setStoreyName(name);
      v.setFloorClipPlane(false, 0);
      if (!name) {
        await vc.dispatch({ t: "storey", keep: null });
        return kick(true);
      }
      const chip = chips.find((c) => c.name === name);
      if (!chip) return;
      const allIds = await v.getAllModelExpressIds();
      const levels = new Map<string, Map<string, Set<number>> | null>();
      for (const id of allIds.keys()) levels.set(id, await v.getModelLevelLocalIds(id));
      const keep = new Map<string, ReadonlySet<number>>();
      for (const p of isolationPlan(chip, allIds, levels)) keep.set(p.modelId, p.show);
      await vc.dispatch({ t: "storey", keep });
      if (withCut) v.setFloorClipPlane(true, sectionHeight(elevations, chip.elevation));
      kick(true);
    },
    [chips, elevations, kick],
  );

  const reset = useCallback(() => {
    const v = viewerRef.current;
    if (!v) return;
    setMode("orbit");
    v.clearSelection();
    setPicked(null);
    setCandidate(null);
    setCut(false);
    setStoreyName(null);
    setSection(EMPTY_SECTION);
    v.setFloorClipPlane(false, 0);
    void visRef.current?.dispatch({ t: "showAll" }).then(() => {
      v.resetCameraToDefault();
      kick();
    });
  }, [kick]);

  const viewerFiles = useMemo(() => {
    if (!testHooksEnabled()) return source.files;
    try {
      return onlyNamed(source.files, localStorage.getItem("ffm.modelOnly"));
    } catch {
      return source.files;
    }
  }, [source.files]);
  const totalBytes = useMemo(() => [...source.sizes.values()].reduce((a, b) => a + b, 0), [source.sizes]);
  const totalBytesRef = useRef(totalBytes);
  totalBytesRef.current = totalBytes;
  // Progressive federation: the smallest models first so the first geometry shows early, the rest streaming in behind.
  const progressive = useProgressiveFiles(viewerFiles, source.sizes, loaded, `${buildingId}:${epoch}`, progressiveEnabled());
  const stagedFiles = progressive.files;
  // The camera frames the first batch only; once everything is in, frame the whole federation again unless the user
  // (or a task focus) already placed the camera.
  const userMovedCamera = useRef(false);
  useEffect(() => {
    userMovedCamera.current = false;
  }, [buildingId, epoch]);
  const lastFramed = useRef(0);
  useEffect(() => {
    if (!progressive.complete || phase !== "ready" || loaded < viewerFiles.length || loaded === 0) return;
    if (focusTaskId || linkRef.current || userMovedCamera.current || lastFramed.current === loaded) return;
    lastFramed.current = loaded;
    const t = window.setTimeout(() => {
      if (!userMovedCamera.current) fit();
    }, 400);
    return () => window.clearTimeout(t);
  }, [progressive.complete, phase, loaded, viewerFiles.length, focusTaskId, fit]);
  // ── 3D tools: section, visibility, tree, search ─────────────────────
  const modelLabels = useMemo(() => {
    const m = new Map<string, string>();
    for (const f of source.files) m.set(f.file.id, f.file.name.replace(/\.[a-z0-9]+$/i, "").toUpperCase());
    return m;
  }, [source.files]);
  const chipModels = useMemo(() => [...modelLabels].map(([modelId, label]) => ({ modelId, label })).filter((m) => (testHooksEnabled() ? viewerFiles.some((f) => f.file.id === m.modelId) : true)), [modelLabels, viewerFiles]);
  const pickedKey = picked ? `${picked.modelId}:${picked.localId}` : null;
  const pickedTitle = picked ? (propsState.status === "ready" ? propsState.props.title : `Element ${picked.localId}`) : null;

  // Slider ranges: the models' box plus slack, known once the models are in.
  useEffect(() => {
    if (loaded === 0 || phase !== "ready") return;
    setSecBounds(rangeBounds(modelsBox(engineRef.current)));
  }, [loaded, phase, epoch]);

  // Section planes follow the state: planes whose numbers changed are updated in place (no geometry is created).
  useEffect(() => {
    const v = viewerRef.current;
    if (!v || phase !== "ready" || !secBounds) return;
    const want = sectionPlanes(section, secBounds);
    const have = v.getSectionPlanes();
    const ops = diffPlanes(have, want);
    if (ops.length === 0) return;
    for (const op of ops) {
      if (op.op === "update") v.updateSectionPlane(op.index, op.plane);
      else if (op.op === "add") v.addSectionPlane(op.plane.point, op.plane.normal, { styled: false, helper: false });
      else v.removeSectionPlane(op.index);
    }
    kick(true);
  }, [section, secBounds, phase, epoch, kick]);

  const boxAroundView = useCallback(() => {
    const pose = poseOf(viewerRef.current?.getPose({ silent: true }) ?? null);
    const models = modelsBox(engineRef.current);
    if (!pose || !models || !secBounds) return;
    const b = viewBox(pose, models, aspect());
    if (b) setSection((st) => ({ ...st, box: clampBox(b, secBounds) }));
  }, [secBounds]);

  const boxAroundSelection = useCallback(async () => {
    const sel = live.current.picked;
    if (!sel || !secBounds) return;
    const b = await indexRef.current?.box(sel.modelId, [sel.localId]);
    if (b) setSection((st) => ({ ...st, box: clampBox(boxAround(b, 0.5), secBounds) }));
  }, [secBounds]);

  const setEdge = useCallback((axis: Axis, edge: "min" | "max", value: number) => setSection((st) => (st.box && secBounds ? { ...st, box: setBoxEdge(st.box, axis, edge, value, secBounds) } : st)), [secBounds]);

  const addPlane = useCallback(
    (axis: Axis) => {
      const pose = viewerRef.current?.getPose({ silent: true });
      if (!secBounds) return;
      const i = axisIndex(axis);
      const at = pose ? pose.target[i] : (secBounds.min[i] + secBounds.max[i]) / 2;
      const offset = Math.min(Math.max(at, secBounds.min[i]), secBounds.max[i]);
      setSection((st) => (st.planes.length >= 8 ? st : { ...st, planes: [...st.planes, { axis, offset, flipped: false }] }));
    },
    [secBounds],
  );
  const patchPlane = useCallback((k: number, patch: Partial<AxisPlane>) => setSection((st) => ({ ...st, planes: st.planes.map((p, j) => (j === k ? { ...p, ...patch } : p)) })), []);
  const removePlane = useCallback((k: number) => setSection((st) => ({ ...st, planes: st.planes.filter((_, j) => j !== k) })), []);

  // Visibility actions
  const selSets = (): IdSets | null => (live.current.picked ? idsOf(live.current.picked.modelId, [live.current.picked.localId]) : null);
  /** Isolating replaces the level filter (one decides what is shown at a time): drop the level and its cut from the UI too. */
  const dropLevel = () => {
    setStoreyName(null);
    setCut(false);
    viewerRef.current?.setFloorClipPlane(false, 0);
  };
  const isolateSelection = () => {
    const ids = selSets();
    if (!ids) return;
    dropLevel();
    void visRef.current?.dispatch({ t: "isolate", ids });
  };
  const hideSelection = () => {
    const ids = selSets();
    if (!ids) return;
    clearPick();
    void visRef.current?.dispatch({ t: "hide", ids });
  };
  const toggleXray = () => {
    const vc = visRef.current;
    if (!vc) return;
    if (vc.state.solid) return void vc.dispatch({ t: "xray", solid: null });
    const ids = selSets();
    if (ids) void vc.dispatch({ t: "xray", solid: ids });
  };

  // Filters sheet: level, models, categories (remembered per building)
  const levelNames = useMemo(() => chips.map((c) => c.name), [chips]);
  const filterModels = useMemo<FilterModel[]>(
    () => chipModels.map((m, i) => ({ modelId: m.modelId, label: m.label, visible: !vis.hiddenModels.has(m.modelId), color: MODEL_COLORS[i % MODEL_COLORS.length] })),
    [chipModels, vis.hiddenModels],
  );
  const items = useMemo(
    () =>
      filterItems({
        level: storeyName,
        cut,
        modelsTotal: chipModels.length,
        modelsVisible: chipModels.filter((m) => !vis.hiddenModels.has(m.modelId)).length,
        categoriesHidden: vis.hiddenCategories.size,
        isolated: vis.isolated !== null,
        xray: vis.solid !== null,
        elementsHidden: vis.hiddenIds.size > 0,
      }),
    [storeyName, cut, chipModels, vis],
  );
  const setLevel = useCallback((name: string | null) => void chooseStorey(name, name !== null && cut), [chooseStorey, cut]);
  const setCutOn = useCallback(
    (on: boolean) => {
      setCut(on);
      if (live.current.storeyName) void chooseStorey(live.current.storeyName, on);
    },
    [chooseStorey],
  );
  const setAllModels = useCallback(
    (visible: boolean) => {
      for (const m of chipModels) void visRef.current?.dispatch({ t: "model", modelId: m.modelId, visible });
    },
    [chipModels],
  );
  const setAllCategories = useCallback(
    (visible: boolean) => {
      if (visible) void visRef.current?.dispatch({ t: "clearCategories" });
      else void visRef.current?.dispatch({ t: "allCategories", names: (catRows ?? []).map((c) => c.name) });
    },
    [catRows],
  );
  const resetFilters = useCallback(() => {
    setCut(false);
    setStoreyName(null);
    viewerRef.current?.setFloorClipPlane(false, 0);
    void visRef.current?.dispatch({ t: "showAll" });
    kick(true);
  }, [kick]);
  const removeFilter = useCallback(
    (kind: FilterKind) => {
      const vc = visRef.current;
      if (!vc) return;
      if (kind === "level") {
        setCut(false);
        void chooseStorey(null, false);
      } else if (kind === "models") void vc.dispatch({ t: "clearModels" });
      else if (kind === "categories") void vc.dispatch({ t: "clearCategories" });
      else if (kind === "isolate") void vc.dispatch({ t: "clearIsolate" });
      else if (kind === "hidden") void vc.dispatch({ t: "clearHidden" });
      else void vc.dispatch({ t: "xray", solid: null });
    },
    [chooseStorey],
  );

  // ── saved views: camera + level/filters + section + hidden elements, per building ──
  const savedViews = useSavedViews(projectId, buildingId);
  const [viewsNote, setViewsNote] = useState<string | null>(null);
  const saveCurrentView = useCallback(
    (name: string) => {
      const v = viewerRef.current;
      const vc = visRef.current;
      if (!v || !vc) return;
      const pose = v.getPose({ silent: true });
      const blob = captureView({
        pose: pose ? { pos: pose.pos, target: pose.target, fov: pose.fov, isOrtho: pose.isOrtho } : null,
        section: liveSection.current,
        secBounds,
        vis: vc.state,
        level: live.current.storeyName,
        cut: cut && live.current.storeyName !== null,
        buildingId,
      });
      setViewsNote(null);
      void saveView(viewpointDb, projectId, buildingId, name, blob).catch(() => setViewsNote("The view could not be saved."));
    },
    [buildingId, projectId, secBounds, cut],
  );
  const restoreSavedView = useCallback(
    async (sv: SavedView) => {
      const v = viewerRef.current;
      const vc = visRef.current;
      if (!v || !vc || !sv.blob) return;
      const plan = restorePlan(sv.blob);
      // Filters first (the camera flies while they apply). Order matters: isolate / level reset the hidden ids.
      await vc.dispatch({ t: "showAll" });
      for (const modelId of plan.hiddenModels) void vc.dispatch({ t: "model", modelId, visible: false });
      for (const name of plan.hiddenCategories) void vc.dispatch({ t: "category", name, visible: false });
      if (plan.isolated) {
        setStoreyName(null);
        setCut(false);
        v.setFloorClipPlane(false, 0);
        void vc.dispatch({ t: "isolate", ids: plan.isolated });
      } else if (plan.level && levelNames.includes(plan.level)) {
        setCut(plan.cut);
        await chooseStorey(plan.level, plan.cut);
      } else {
        setStoreyName(null);
        setCut(false);
        v.setFloorClipPlane(false, 0);
        await vc.dispatch({ t: "storey", keep: null });
      }
      if (plan.hiddenIds.size) void vc.dispatch({ t: "hide", ids: plan.hiddenIds });
      if (plan.forced.size) void vc.dispatch({ t: "show", ids: plan.forced });
      if (plan.solid) void vc.dispatch({ t: "xray", solid: plan.solid });
      setSection(plan.section);
      if (plan.pose) {
        userMovedCamera.current = true;
        v.setViewPose({ pos: plan.pose.pos, target: plan.pose.target, fov: plan.pose.fov, isOrtho: plan.pose.isOrtho }, { animate: true });
      }
      kick(true);
      if (plan.droppedPlanes > 0) setViewsNote(`${plan.droppedPlanes} slanted section plane${plan.droppedPlanes === 1 ? "" : "s"} from the web could not be restored.`);
      else {
        setViewsNote(null);
        setPanel(null);
      }
    },
    [chooseStorey, kick, levelNames],
  );

  // Restore the remembered filters once per viewer instance (after the first model is in), and re-apply them as the other models arrive.
  const restoredFor = useRef(-1);
  useEffect(() => {
    if (phase !== "ready" || loaded === 0) return;
    const vc = visRef.current;
    const index = indexRef.current;
    if (!vc || !index) return;
    if (restoredFor.current === epoch) {
      void vc.refresh();
      if (live.current.storeyName) void chooseStorey(live.current.storeyName, cut);
      return;
    }
    const saved = loadPrefs(buildingId);
    if (saved.level && chips.length === 0) return; // wait for the synced storeys
    restoredFor.current = epoch;
    const prefs = sanitizePrefs(saved, { levels: levelNames, models: chipModels.map((m) => m.modelId) });
    for (const modelId of prefs.hiddenModels) void vc.dispatch({ t: "model", modelId, visible: false });
    for (const name of prefs.hiddenCategories) void vc.dispatch({ t: "category", name, visible: false });
    if (prefs.level) {
      setCut(prefs.cut);
      void chooseStorey(prefs.level, prefs.cut);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, loaded, epoch, chips.length]);
  useEffect(() => {
    if (restoredFor.current !== epoch) return;
    savePrefs(buildingId, { level: storeyName, cut: cut && storeyName !== null, hiddenModels: [...vis.hiddenModels], hiddenCategories: [...vis.hiddenCategories] });
  }, [buildingId, epoch, storeyName, cut, vis.hiddenModels, vis.hiddenCategories]);

  // Categories of all models, merged by class (read when the panel opens).
  useEffect(() => {
    if (panel !== "filters" || phase !== "ready") return;
    const index = indexRef.current;
    if (!index) return;
    let alive = true;
    void (async () => {
      const by = new Map<string, number>();
      for (const id of index.modelIds()) for (const [c, ids] of await index.categories(id)) by.set(c, (by.get(c) ?? 0) + ids.length);
      if (alive) setCatRows([...by].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)));
    })();
    return () => {
      alive = false;
    };
  }, [panel, phase, epoch, loaded]);

  // The tree: spatial structures are read when the sheet opens and dropped when it closes.
  useEffect(() => {
    if (panel !== "tree" || phase !== "ready") {
      setTreeRoots(null);
      setTreeError(null);
      return;
    }
    const index = indexRef.current;
    if (!index) return;
    let alive = true;
    void (async () => {
      try {
        const roots: TNode[] = [];
        for (const id of index.modelIds()) {
          const root = await index.spatial(id);
          if (root) roots.push(buildModelTree(id, modelLabels.get(id) ?? "MODEL", root));
        }
        if (alive) setTreeRoots(roots);
      } catch (e) {
        if (alive) setTreeError(`Could not read the model structure (${String((e as Error)?.message ?? e)}).`);
      }
    })();
    return () => {
      alive = false;
      setTreeRoots(null);
    };
  }, [panel, phase, epoch, loaded, modelLabels]);

  const treeNames = useCallback((modelId: string, ids: readonly number[]) => indexRef.current?.names(modelId, ids) ?? Promise.resolve(new Map<number, string>()), []);

  /** Select an element and fly to it; an element that is hidden is shown first (a hidden element is never selectable). */
  const focusElement = useCallback(
    async (modelId: string, localId: number) => {
      const v = viewerRef.current;
      const vc = visRef.current;
      const index = indexRef.current;
      if (!v || !vc || !index) return;
      if (vc.state.hiddenModels.has(modelId)) await vc.dispatch({ t: "model", modelId, visible: true });
      const h = vc.hidden(modelId);
      if (h?.ids.has(localId) || vc.state.isolated || vc.state.storey) await vc.dispatch({ t: "show", ids: idsOf(modelId, [localId]) });
      tapGate.current.invalidate();
      v.selectElement(modelId, localId);
      setCandidate(null);
      setPicked({ modelId, localId, point: null });
      const box = await index.box(modelId, [localId]);
      const cur = poseOf(v.getPose({ silent: true }));
      if (box && cur) {
        v.setViewPose({ ...flyPose(box, cur, aspect()), isOrtho: false }, { animate: true });
        if (testHooksEnabled()) (window as unknown as { __ffmFly?: unknown }).__ffmFly = { modelId, localId, box };
      }
      kick(true);
    },
    [kick],
  );

  const frameIds = useCallback(
    async (modelId: string, ids: readonly number[]) => {
      const v = viewerRef.current;
      const box = await indexRef.current?.box(modelId, ids);
      const cur = poseOf(v?.getPose({ silent: true }) ?? null);
      if (v && box && cur) v.setViewPose({ ...flyPose(box, cur, aspect(), 3, 1.15), isOrtho: false }, { animate: true });
      kick(true);
    },
    [kick],
  );

  const treeSelect = useCallback(
    (n: TNode) => {
      if (n.localId !== null) void focusElement(n.modelId, n.localId);
    },
    [focusElement],
  );
  const treeToggle = useCallback((n: TNode, visible: boolean) => {
    const vc = visRef.current;
    if (!vc) return;
    if (n.kind === "model") return void vc.dispatch({ t: "model", modelId: n.modelId, visible });
    void vc.dispatch({ t: visible ? "show" : "hide", ids: idsOf(n.modelId, n.ids()) });
  }, []);
  const treeIsolate = useCallback(
    (n: TNode) => {
      const ids = n.ids();
      dropLevel();
      void visRef.current?.dispatch({ t: "isolate", ids: idsOf(n.modelId, ids) });
      void frameIds(n.modelId, ids);
    },
    [frameIds],
  );

  const doSearch = useCallback((q: string) => {
    const index = indexRef.current;
    const eng = engineRef.current;
    const token = ++searchToken.current;
    const parsed = parseQuery(q);
    if (!index || !eng) return;
    if (parsed.kind === "empty") {
      setSearchRes(null);
      setSearchBusy(false);
      return;
    }
    setSearchBusy(true);
    void runSearch(index, () => eng.fragments.core.models.list, parsed, () => token !== searchToken.current)
      .then((res) => {
        if (token !== searchToken.current) return;
        setSearchRes(res);
        if (testHooksEnabled()) (window as unknown as { __ffmSearch?: unknown }).__ffmSearch = { query: q, total: res.total, rows: res.rows.length, categories: res.categories.length };
      })
      .catch((e) => {
        console.warn("[model] search failed", e);
        if (token === searchToken.current) setSearchRes({ query: q, rows: [], total: 0, truncated: false, categories: [] });
      })
      .finally(() => {
        if (token === searchToken.current) setSearchBusy(false);
      });
  }, []);
  const pickSearchRow = useCallback((r: SearchRow) => void focusElement(r.modelId, r.localId), [focusElement]);
  const isolateCategory = useCallback(
    async (name: string) => {
      const index = indexRef.current;
      if (!index) return;
      const ids = new Map<string, Set<number>>();
      for (const id of index.modelIds()) {
        const list = (await index.categories(id)).get(name);
        ids.set(id, new Set(list ? Array.from(list) : []));
      }
      dropLevel();
      await visRef.current?.dispatch({ t: "isolate", ids });
      const first = [...ids].find(([, s]) => s.size > 0);
      if (first) void frameIds(first[0], [...first[1]]);
    },
    [frameIds],
  );

  // Leaving the model ends the panels; measuring and walking own the screen.
  useEffect(() => {
    if (!active || phase === "released" || phase === "reloading") closePanels();
  }, [active, phase, closePanels]);
  useEffect(() => {
    if (measuring || mode === "walk") closePanels();
  }, [measuring, mode, closePanels]);

  // ── first person ────────────────────────────────────────────────────
  const walk = useRef<{ state: WalkState; input: WalkInput; raf: number | null; last: number; back: ViewerPose | null } | null>(null);

  const applyWalk = useCallback(() => {
    const w = walk.current;
    const v = viewerRef.current;
    if (!w || !v) return;
    const p = walkPose(w.state, 60);
    v.navigateTo(xyz(p.pos), xyz(p.target));
    kick();
    const s = w.state;
    if (linkRef.current) {
      lastLink.current = { x: s.x, z: s.z, floorY: s.floorY, yaw: s.yaw };
      linkRef.current.onChange(lastLink.current);
    } else {
      walkerStore.set({ x: s.x, z: s.z, floorY: s.floorY, yaw: s.yaw });
    }
  }, [kick, walkerStore]);

  const walkTick = useCallback(() => {
    const w = walk.current;
    if (!w) return;
    const now = performance.now();
    w.state = stepWalk(w.state, w.input, (now - w.last) / 1000);
    w.last = now;
    applyWalk();
    w.raf = w.input.forward !== 0 || w.input.strafe !== 0 ? requestAnimationFrame(walkTick) : null;
  }, [applyWalk]);

  const stopWalkLoop = () => {
    const w = walk.current;
    if (w?.raf != null) cancelAnimationFrame(w.raf);
    if (w) w.raf = null;
  };

  const enterWalk = useCallback(async () => {
    const v = viewerRef.current;
    const stage = stageRef.current;
    if (!v || !stage) return;
    const cur = v.getPose({ silent: true });
    if (!cur) return;
    const r = stage.getBoundingClientRect();
    const hit = await v.pickWorldPoint(r.left + r.width / 2, r.top + r.height / 2);
    const box = modelsBox(engineRef.current);
    const centre = modelsCenter(engineRef.current);
    // Stand where the view points (pulled back a little toward the camera so we are not inside the wall).
    const dir: Vec3 = [cur.target[0] - cur.pos[0], 0, cur.target[2] - cur.pos[2]];
    const dl = Math.hypot(dir[0], dir[2]) || 1;
    const at = hit
      ? { x: hit.x - (dir[0] / dl) * 0.8, z: hit.z - (dir[2] / dl) * 0.8 }
      : { x: centre?.[0] ?? cur.target[0], z: centre?.[2] ?? cur.target[2] };
    const floorY = walkEntryFloor(elevations, hit ? hit.y : (centre?.[1] ?? 0), cur.pos[1], box ? box.max[1] : null) ?? box?.min[1] ?? 0;
    const state = walkFromPose(cur, at, floorY);
    walk.current = { state, input: { forward: 0, strafe: 0 }, raf: null, last: performance.now(), back: cur };
    setPicked(null);
    setCandidate(null);
    v.clearSelection();
    setMode("walk");
    // Walking inside a building streams every nearby tile in full detail: on a heavy federation work in the leaner
    // "low" memory state (tighter culling, smaller caches) for the walk, back to the real pressure level on exit.
    if (totalBytesRef.current > HEAVY_WALK_BYTES) v.setMemoryPressure(maxPressure("low", getPressure()));
    setWalkFloor(state.floorY);
    walkerStore.set({ x: state.x, z: state.z, floorY: state.floorY, yaw: state.yaw });
    const p = walkPose(state, 60);
    v.setViewPose({ pos: p.pos, target: p.target, fov: 60, isOrtho: false }, { animate: false });
    kick();
  }, [elevations, kick, walkerStore]);

  const exitWalk = useCallback(() => {
    stopWalkLoop();
    const back = walk.current?.back;
    walk.current = null;
    walkerStore.set(null);
    setMode("orbit");
    setWalkFloor(null);
    viewerRef.current?.setMemoryPressure(getPressure());
    if (back) viewerRef.current?.setViewPose(back, { animate: true });
    kick();
  }, [kick, walkerStore]);

  /** Walk level picker: stand on another storey, same x/z and heading, eye at its elevation + eye height. */
  const walkToLevel = useCallback(
    (level: WalkLevel) => {
      const w = walk.current;
      if (!w) return;
      w.state = withLevel(w.state, level);
      setWalkFloor(w.state.floorY);
      applyWalk();
    },
    [applyWalk],
  );
  const levelsForWalk = useMemo(() => walkLevels(chips), [chips]);

  // ── walk split: plan of the walker's level; tapping it moves the walker, the marker follows the walker ──
  const walkPlan = useMemo(() => (mode === "walk" && !linkview && walkFloor !== null && linkData ? planForWalkLevel(linkData.plans, levelsForWalk, walkFloor, planPref) : null), [mode, linkview, walkFloor, linkData, levelsForWalk, planPref]);
  const splitOn = walkPlan !== null;
  const noPlanLevel = mode === "walk" && !linkview && walkFloor !== null && !!linkData && !walkPlan ? (levelsForWalk[levelIndexFor(levelsForWalk, walkFloor)]?.name ?? "this level") : null;
  useEffect(() => {
    const el = modelRef.current;
    if (!el) return;
    const apply = () => setSplitDir(splitDirection(el.clientWidth, el.clientHeight));
    apply();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    if (walkPlan) setPlanPref(walkPlan.pdfFileId);
  }, [walkPlan]);
  const walkMoveTo = useCallback(
    (to: LinkWalker) => {
      const w = walk.current;
      if (!w) return;
      w.state = { ...w.state, x: to.x, z: to.z, yaw: to.yaw };
      applyWalk();
    },
    [applyWalk],
  );
  const walkTurnTo = useCallback(
    (yaw: number) => {
      const w = walk.current;
      if (!w) return;
      w.state = { ...w.state, yaw };
      applyWalk();
    },
    [applyWalk],
  );

  // ── Link view: the walker is driven from outside, and starts (again after a renderer recovery) on its own ──
  useEffect(() => {
    const b = linkRef.current;
    if (!b) return;
    b.controlRef.current = {
      place(p) {
        const next = { ...(lastLink.current ?? b.initial), ...p };
        lastLink.current = next;
        const w = walk.current;
        if (!w) return; // not walking yet: the entry effect below starts at the remembered position
        w.state = { ...w.state, x: next.x, z: next.z, floorY: next.floorY, yaw: next.yaw };
        setWalkFloor(next.floorY);
        applyWalk();
      },
      current: () => lastLink.current,
    };
    return () => {
      b.controlRef.current = null;
    };
  }, [applyWalk, !!linkview]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const b = linkRef.current;
    const v = viewerRef.current;
    if (!b || !v || phase !== "ready" || loaded === 0 || mode === "walk") return;
    const s = lastLink.current ?? b.initial;
    walk.current = { state: { x: s.x, z: s.z, floorY: s.floorY, yaw: s.yaw, pitch: 0 }, input: { forward: 0, strafe: 0 }, raf: null, last: performance.now(), back: null };
    userMovedCamera.current = true;
    setPicked(null);
    setCandidate(null);
    v.clearSelection();
    setMode("walk");
    if (totalBytesRef.current > HEAVY_WALK_BYTES) v.setMemoryPressure(maxPressure("low", getPressure()));
    setWalkFloor(s.floorY);
    const p = walkPose(walk.current.state, 60);
    v.setViewPose({ pos: p.pos, target: p.target, fov: 60, isOrtho: false }, { animate: false });
    kick();
  }, [phase, loaded, mode, epoch, kick]);

  // The Link view's entry from the 3D view reads where the user is: storey, position, heading.
  useEffect(() => {
    if (!linkContext) return;
    linkContext.current = {
      read() {
        const lv = levelsForWalk;
        const w = walk.current;
        const pose = viewerRef.current?.getPose({ silent: true }) ?? null;
        const floorY = w ? w.state.floorY : pose ? floorForY(elevations, pose.target[1]) : null;
        const idx = floorY === null ? -1 : levelIndexFor(lv, floorY);
        const byFilter = live.current.storeyName;
        const yaw = w ? w.state.yaw : pose ? walkFromPose(pose, { x: pose.pos[0], z: pose.pos[2] }, 0).yaw : null;
        return { storeyName: byFilter ?? (idx >= 0 ? lv[idx].name : null), floorY, x: w ? w.state.x : (pose?.target[0] ?? null), z: w ? w.state.z : (pose?.target[2] ?? null), yaw };
      },
    };
    return () => {
      linkContext.current = null;
    };
  }, [linkContext, levelsForWalk, elevations]);

  useEffect(() => () => stopWalkLoop(), []);

  // ── task focus (`?task=`) ───────────────────────────────────────────
  const focusedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!focusTaskId) {
      focusedFor.current = null;
      setFocusedId(null);
      return;
    }
    if (loaded === 0 || focusedFor.current === focusTaskId) return;
    const pin = pins.find((p) => p.taskId === focusTaskId);
    const v = viewerRef.current;
    const cur = poseOf(v?.getPose({ silent: true }) ?? null);
    if (!pin || !v || !cur) return;
    focusedFor.current = focusTaskId;
    setFocusedId(focusTaskId);
    const stage = stageRef.current;
    const stored = pin.cameraPose ? { pos: pin.cameraPose.pos, target: pin.cameraPose.target, fov: pin.cameraPose.fov } : null;
    const view = choosePinView(pin.worldPoint, stored, cur, stage?.clientWidth ?? 800, stage?.clientHeight ?? 500);
    v.setViewPose({ ...view, isOrtho: false }, { animate: !captureRef.current });
    kick();
  }, [focusTaskId, loaded, pins, kick]);

  // ── HD capture for a task markup (opt-in) ───────────────────────────
  const captureRef = useRef(capture);
  captureRef.current = capture;
  const capturedRef = useRef(false);
  const everythingIn = progressive.complete && phase === "ready" && loaded > 0 && loaded >= viewerFiles.length;
  useEffect(() => {
    const cap = captureRef.current;
    if (!cap || capturedRef.current || !everythingIn) return;
    const pin = pins.find((p) => p.taskId === cap.taskId) ?? null;
    if (pin && focusedId !== cap.taskId) return; // wait until the camera is at the task's view
    const timer = window.setTimeout(() => {
      if (capturedRef.current) return;
      capturedRef.current = true;
      void (async () => {
        const ctx = ctxRef.current;
        const v = viewerRef.current;
        const stage = stageRef.current;
        const three = getRenderer(ctx);
        if (!ctx || !v || !stage || !three) return cap.onResult({ ok: false, message: "The 3D view is not available." });
        const prev = three.getPixelRatio();
        try {
          const css = { width: stage.clientWidth, height: stage.clientHeight };
          applyPixelRatio(ctx, hdPixelRatio(css.width, css.height, prev));
          await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
          const scene = (ctx.world.scene as { three?: unknown }).three;
          const camera = ctx.camera.three;
          if (!scene) throw new Error("no scene");
          const pt = pin ? v.worldToScreen(xyz(pin.worldPoint)) : null;
          const frame = await readFrame({
            canvas: three.domElement,
            render: () => three.render(scene as never, camera),
            pin: pt ? { x: pt.x, y: pt.y } : null,
            css,
          });
          cap.onResult({ ok: true, ...frame });
        } catch (e) {
          cap.onResult({ ok: false, message: (e as Error).message || "The 3D capture failed." });
        } finally {
          applyPixelRatio(ctx, prev);
        }
      })();
    }, SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [everythingIn, pins, focusedId]);

  // ── memory pressure: release in the background, reload on resume ────
  useEffect(() => {
    const guard = new BackgroundGuard({
      releaseAfterMs,
      setTimer: (cb, ms) => window.setTimeout(cb, ms),
      clearTimer: (t) => window.clearTimeout(t as number),
      onRelease: () => {
        const pose = viewerRef.current?.getPose({ silent: true });
        if (pose) savedPoseRef.current = pose;
        console.info("[model] released in background");
        setMode("orbit");
        setLoaded(0);
        setPhase("released");
        setActive(false);
      },
      onRestore: () => {
        console.info("[model] restoring after resume");
        statsRef.current.reloads++;
        setPhase("loading");
        setActive(true);
        setEpoch((e) => e + 1);
      },
    });
    const sub = CapApp.addListener("appStateChange", ({ isActive }) => (isActive ? guard.visible() : guard.hidden()));
    const onVis = () => (document.hidden ? guard.hidden() : guard.visible());
    document.addEventListener("visibilitychange", onVis);
    // e2e seam: present only in builds with VITE_FFM_TEST_HOOKS=true
    if (testHooksEnabled()) (window as unknown as { __ffmBgGuard?: BackgroundGuard }).__ffmBgGuard = guard;
    return () => {
      guard.dispose();
      document.removeEventListener("visibilitychange", onVis);
      void sub.then((h) => h.remove()).catch(() => undefined);
      if (testHooksEnabled()) delete (window as unknown as { __ffmBgGuard?: BackgroundGuard }).__ffmBgGuard;
    };
  }, []);

  // Heap watchdog: JS heap above 85 % of the limit while idle -> rebuild the world (frees the fragments worker copies).
  useEffect(() => {
    const t = window.setInterval(() => {
      const mem = (performance as unknown as { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
      const pr = heapPressure(mem);
      if (pr !== null && pr > 0.85 && live.current.phase === "ready") reload("js heap pressure");
    }, 10_000);
    return () => window.clearInterval(t);
  }, [reload]);

  // ── metrics + debug probe (spike document and e2e) ──────────────────
  useEffect(() => {
    if (!testHooksEnabled()) return; // release builds carry no probes
    const gl = webgl2Info();
    const metrics = {
      webgl2: gl.webgl2,
      renderer: gl.renderer,
      installMs: source.installMs ?? null,
      loadMs: null as number | null,
      modelsLoaded: 0,
      heapMbBefore: jsHeapMb(),
      heapMbAfter: null as number | null,
      errors: [] as string[],
    };
    (window as unknown as { __ffmModel?: unknown }).__ffmModel = metrics;
    const onErr = (e: ErrorEvent) => metrics.errors.push(e.message);
    window.addEventListener("error", onErr);
    const debug: ModelDebug = {
      state: () => ({ ...live.current, pins: live.current.pins.length, chips: live.current.chips.map((c) => c.name), ...statsRef.current, source: source.kind, buildingId, projectId }),
      pose: () => viewerRef.current?.getPose({ silent: true }) ?? null,
      pixelRatio: () => getRenderer(engineRef.current)?.getPixelRatio() ?? null,
      overlay: () => {
        const s = schedulerRef.current;
        return s ? { running: s.running, frames: s.frames, runs: s.runs } : null;
      },
      renderStats: () => viewerRef.current?.getRenderStats?.() ?? null,
      registry: () => viewerRegistry.stats(),
      loseContext: () => loseContext(engineRef.current),
      simulateBackground: async (ms) => {
        const g = (window as unknown as { __ffmBgGuard?: BackgroundGuard }).__ffmBgGuard;
        g?.hidden();
        await sleep(ms);
        g?.visible();
      },
      pinScreen: (taskId) => {
        const pin = live.current.pins.find((p) => p.taskId === taskId);
        const v = viewerRef.current;
        const stage = stageRef.current;
        const pose = poseOf(v?.getPose({ silent: true }) ?? null);
        if (!pin || !v || !stage || !pose) return null;
        const el = stage.querySelector<HTMLElement>(`[data-task-id="${taskId}"]`);
        const r = stage.getBoundingClientRect();
        const h = v.worldToScreen(xyz(pin.worldPoint));
        const ours = pose && el?.dataset.visible === "true" ? el.getBoundingClientRect() : null;
        return {
          x: ours ? ours.left + ours.width / 2 : NaN,
          y: ours ? ours.top + ours.height / 2 : NaN,
          handle: h ? { x: h.x + r.left, y: h.y + r.top } : null,
          visible: el?.dataset.visible === "true",
        };
      },
      stage: () => {
        const r = stageRef.current?.getBoundingClientRect();
        return r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null;
      },
      elementAt: (x, y) => raycastAt(engineRef.current, x, y),
      heapMb: jsHeapMb,
      modelBoxes: () => perModelBoxes(engineRef.current),
      models: () => engineRef.current?.fragments.core.models.list ?? new Map(),
      drawStats: () => {
        const r = getRenderer(engineRef.current);
        return r ? { calls: r.info.render.calls, triangles: r.info.render.triangles } : null;
      },
      tools: () => {
        const vc = visRef.current;
        const st = vc?.state ?? INITIAL_VIS;
        const hiddenCount: Record<string, { all: boolean; n: number }> = {};
        for (const id of indexRef.current?.modelIds() ?? []) {
          const h = vc?.hidden(id);
          hiddenCount[id] = { all: !!h?.all, n: h?.ids.size ?? 0 };
        }
        return {
          panel: livePanel.current,
          section: { box: liveSection.current.box !== null, planes: liveSection.current.planes.length, enginePlanes: (viewerRef.current?.getSectionPlanes() ?? []).map((p) => ({ point: toVec(p.point), normal: toVec(p.normal) })) },
          hiddenModels: [...st.hiddenModels],
          hiddenCategories: [...st.hiddenCategories],
          isolated: st.isolated !== null,
          storey: st.storey !== null,
          xray: st.solid !== null,
          hiddenCount,
        };
      },
      sampleElement: async (skip = 0) => {
        for (const [modelId, m] of engineRef.current?.fragments.core.models.list ?? []) {
          const ids = await m.getItemsIdsWithGeometry();
          const localId = ids[Math.min(skip, ids.length - 1)];
          if (localId === undefined) continue;
          const [guid] = await m.getGuidsByLocalIds([localId]);
          const rows = await m.getItemsData([localId], { attributesDefault: false, attributes: ["Name"], relationsDefault: { attributes: false, relations: false } });
          const n = (rows[0] as { Name?: { value?: unknown } } | undefined)?.Name?.value;
          return { modelId, localId, guid: guid ?? null, name: typeof n === "string" ? n : null };
        }
        return null;
      },
      selectionScreen: async () => {
        const v = viewerRef.current;
        const stage = stageRef.current;
        if (!v || !stage) return null;
        const c = await v.getSelectionWorldCenter();
        const p = c ? v.worldToScreen(c) : null;
        if (!p) return null;
        const r = stage.getBoundingClientRect();
        return { x: p.x + r.left, y: p.y + r.top, onScreen: p.x >= 0 && p.y >= 0 && p.x <= r.width && p.y <= r.height };
      },
      measureItems: () => {
        const ctx = ctxRef.current;
        if (!ctx) return [];
        const v3 = (p: { x: number; y: number; z: number }): Vec3 => [p.x, p.y, p.z];
        const out: Array<{ variant: MeasureVariant; points: Vec3[] }> = [];
        for (const variantName of ["length", "area", "angle"] as const) {
          for (const raw of engineItems(ctx, variantName)) {
            const it = raw as { start?: { x: number; y: number; z: number }; end?: { x: number; y: number; z: number }; vertex?: { x: number; y: number; z: number }; points?: Iterable<{ x: number; y: number; z: number }> };
            const pts = variantName === "length" ? [it.start, it.end] : variantName === "angle" ? [it.start, it.vertex, it.end] : [...(it.points ?? [])];
            out.push({ variant: variantName, points: pts.filter((p): p is { x: number; y: number; z: number } => !!p).map(v3) });
          }
        }
        return out;
      },
      thinCandidates: async () => {
        const eng = engineRef.current;
        const r = stageRef.current?.getBoundingClientRect();
        if (!eng || !r) return [];
        const found = new Map<string, { modelId: string; localId: number; hits: number; x: number; y: number }>();
        for (let j = 0; j < 30; j++) {
          for (let i = 0; i < 40; i++) {
            const x = r.left + r.width * (0.1 + (i / 39) * 0.8);
            const y = r.top + r.height * (0.15 + (j / 29) * 0.7);
            const hit = await raycastAt(eng, x, y);
            if (!hit) continue;
            const key = `${hit.modelId}:${hit.localId}`;
            const cur = found.get(key);
            if (cur) cur.hits++;
            else found.set(key, { modelId: hit.modelId, localId: hit.localId, hits: 1, x, y });
          }
        }
        const out: { modelId: string; localId: number; thickness: number; hits: number; x: number; y: number }[] = [];
        for (const f of found.values()) {
          try {
            const boxes = await eng.fragments.core.models.list.get(f.modelId)?.getBoxes([f.localId]);
            const b = boxes?.[0];
            if (!b || b.isEmpty()) continue;
            const t = Math.min(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z);
            out.push({ ...f, thickness: t });
          } catch {
            /* skip */
          }
        }
        return out.sort((a, b) => a.thickness - b.thickness || a.hits - b.hits);
      },
    };
    window.__ffmModelDebug = debug;
    return () => {
      window.removeEventListener("error", onErr);
      if (window.__ffmModelDebug === debug) delete window.__ffmModelDebug;
    };
  }, [source.installMs, source.kind, buildingId, projectId]);

  // metrics mirror (spike keys)
  useEffect(() => {
    if (!testHooksEnabled()) return;
    const m = (window as unknown as { __ffmModel?: { loadMs: number | null; modelsLoaded: number; heapMbAfter: number | null } }).__ffmModel;
    if (m && loaded > 0 && m.loadMs === null) {
      m.loadMs = statsRef.current.loadMs;
      m.modelsLoaded = loaded;
      m.heapMbAfter = jsHeapMb();
    }
  }, [loaded]);

  const retry = () => {
    statsRef.current.lossTimes = [];
    reload("manual retry");
  };

  const walking = mode === "walk";
  /** Opening the measurements list closes any tool panel and the properties sheet: one sheet at a time. */
  const openMeasureSheet = useCallback(() => {
    setMenuOpen(false);
    setPanel(null);
    setMeasureSheet(true);
  }, []);
  const tuning = useMemo(() => memoryTuning(totalBytes), [totalBytes]);
  // Memory pressure (Android onTrimMemory, JS heap heuristic): shed memory in the viewer before the OS kills us.
  useEffect(() => {
    const stop = startPressureMonitor();
    const apply = (level: ReturnType<typeof getPressure>) => viewerRef.current?.setMemoryPressure(level);
    const off = subscribePressure(apply);
    return () => {
      off();
      stop();
    };
  }, []);
  return (
    <div className="model" ref={modelRef} data-testid="model-page" data-loaded={loaded} data-phase={phase} data-mode={mode} data-source={source.kind} data-split={splitOn ? splitDir : undefined}>
      {splitOn && walkPlan && (
        <div className="walk-split-plan" data-testid="walk-split-plan" data-plan={walkPlan.pdfFileId} data-storey={walkPlan.storeyName}>
          <WalkSplitPlan key={walkPlan.pdfFileId} plan={walkPlan} store={walkerStore} backPath={`/model/${encodeURIComponent(buildingId)}`} onMove={walkMoveTo} onTurn={walkTurnTo} />
        </div>
      )}
      <div className="model-stage" ref={stageRef} data-testid="model-stage" data-tb={layout} onPointerDownCapture={() => { userMovedCamera.current = true; }}>
        {active && (
          <IfcViewer
            key={`${buildingId}:${epoch}`}
            ref={viewerRef}
            className="model-canvas"
            projectId={projectId}
            activeBuildingId={buildingId}
            files={stagedFiles}
            getFragBlob={getFragBlob}
            onReady={onReady}
            fitOnFirstLoad={!focusTaskId && !linkview}
            tileCache={false}
            memoryTuning={tuning}
            loadingOverlay={false}
            builtInClickPick={false}
          />
        )}

        <PinLayer ref={pinLayerRef} pins={pins} focusedId={focusedId} onOpen={(id) => navigate(`/tasks/${id}`)} />

        {noPlanLevel && (
          <p className="walk-noplan" data-testid="walk-noplan" key={noPlanLevel} role="status">
            No plan is calibrated to {noPlanLevel}. Walking full screen.
          </p>
        )}
        {walking && walkFloor !== null && <WalkLevelPicker levels={levelsForWalk} floorY={walkFloor} onPick={walkToLevel} />}
        {walking && <WalkLayer onLook={(dx, dy) => { const w = walk.current; if (w) { w.state = lookBy(w.state, dx, dy); applyWalk(); } }} onMove={(input) => { const w = walk.current; if (!w) return; w.input = input; if (w.raf === null && (input.forward !== 0 || input.strafe !== 0)) { w.last = performance.now(); w.raf = requestAnimationFrame(walkTick); } }} onExit={exitWalk} hideExit={!!linkview} />}

        <CameraToolbar
          layout={layout}
          ready={phase === "ready"}
          walking={walking}
          hide={linkview ? ["fit", "reset", "walk"] : undefined}
          measuring={measuring}
          menuOpen={menuOpen}
          panel={panel}
          toolActive={section.box !== null || section.planes.length > 0}
          measureCount={entries.length}
          onFit={fit}
          onReset={reset}
          onWalk={() => (walking ? exitWalk() : void enterWalk())}
          onMeasure={() => (measuring ? stopMeasure() : startMeasure())}
          onMeasureList={openMeasureSheet}
          onToggleMenu={() => setMenuOpen((o) => !o)}
          onPickTool={(p) => (panel === p ? closePanels() : openPanel(p))}
        />

        {!walking && !measuring && (
          <div className="model-top">
            <FilterSummary items={items} onRemove={removeFilter} onMore={() => openPanel("filters")} />
          </div>
        )}
        {toolbarSlot &&
          createPortal(
            <button type="button" className={`btn filters-btn${items.length > 0 || panel === "filters" ? " primary" : ""}`} data-testid="model-filters" data-count={items.length} aria-haspopup="dialog" aria-expanded={panel === "filters"} disabled={phase !== "ready" || walking || measuring} onClick={() => (panel === "filters" ? closePanels() : openPanel("filters"))}>
              {filtersLabel(items.length)}
            </button>,
            toolbarSlot,
          )}

        {aim3d && (
          <svg className="aim-marker" data-testid="aim-reticle" data-snap={snapKind ?? ""} width="100%" height="100%" aria-hidden="true">
            <line className="aim-link" x1={aim3d.fx} y1={aim3d.fy} x2={aim3d.x} y2={aim3d.y} />
            <circle className="aim-ring" cx={aim3d.x} cy={aim3d.y} r="13" />
            <circle className="aim-dot" cx={aim3d.fx} cy={aim3d.fy} r="5" />
          </svg>
        )}
        {aim3d && stageRef.current && (
          <Loupe
            aim={aim3d}
            snap={snapKind ? SNAP_LABEL[snapKind] : null}
            live={readout}
            bounds={{ w: stageRef.current.clientWidth, h: stageRef.current.clientHeight }}
            draw={(ctx2, w, h) => {
              const src = loupeSrc.current;
              const st = stageRef.current;
              if (!src || !st || src.width === 0) return;
              const r = loupeSource(aim3d, { w: st.clientWidth, h: st.clientHeight }, { w: src.width, h: src.height }, LOUPE_SIZE, 3);
              ctx2.imageSmoothingEnabled = true;
              ctx2.drawImage(src, r.sx, r.sy, r.sw, r.sw, 0, 0, w, h);
            }}
          />
        )}

        {measuring && !measureSheet && (
          <MeasureBar
            variant={variant}
            placed={placed}
            needsPlane={variant !== "volume"}
            planeSet={planeSet}
            onChangePlane={measureChangePlane}
            live={readout}
            notice={notice}
            count={entries.length}
            onVariant={(vv) => setVariant(vv)}
            onUndo={measureUndo}
            onFinish={measureFinish}
            onCancel={measureCancel}
            onDone={stopMeasure}
            onList={openMeasureSheet}
          />
        )}

        {measureSheet && (
          <MeasureSheet
            entries={entries}
            onFocus={(id) => {
              void viewerRef.current?.focusMeasurement?.(id);
              kick(true);
              setMeasureSheet(false);
            }}
            onDelete={(id) => viewerRef.current?.deleteMeasurement?.(id)}
            onClear={() => viewerRef.current?.clearMeasurements()}
            onClose={() => setMeasureSheet(false)}
          />
        )}

        {candidate && !walking && (
          <div className="model-lp" data-testid="model-lp">
            <span className="grow">{candidate.localId >= 0 ? `Element ${candidate.localId}` : "Point on the model"}</span>
            <button type="button" className="btn small primary" data-testid="model-new-task" onClick={() => void newTaskFor(candidate.localId >= 0 ? candidate : { ...candidate, modelId: [...source.modelIds][0] ?? "", localId: -1 })}>
              New task here
            </button>
            <button type="button" className="btn small" aria-label="Dismiss" onClick={() => setCandidate(null)}>
              ✕
            </button>
          </div>
        )}

        {panel === "section" && (
          <SectionPanel
            state={section}
            bounds={secBounds}
            hasSelection={!!picked}
            onBoxView={boxAroundView}
            onBoxSelection={() => void boxAroundSelection()}
            onBoxOff={() => setSection((st) => ({ ...st, box: null }))}
            onEdge={setEdge}
            onAddPlane={addPlane}
            onPlane={patchPlane}
            onRemovePlane={removePlane}
            onReset={() => setSection(EMPTY_SECTION)}
            onClose={closePanels}
          />
        )}
        {panel === "filters" && (
          <FiltersSheet
            levels={levelNames}
            level={storeyName}
            cut={cut}
            models={filterModels}
            categories={catRows}
            hiddenCategories={vis.hiddenCategories}
            hasSelection={!!picked}
            isolated={vis.isolated !== null}
            xray={vis.solid !== null}
            disabled={phase !== "ready"}
            onLevel={setLevel}
            onCut={setCutOn}
            onModel={(modelId, visible) => void visRef.current?.dispatch({ t: "model", modelId, visible })}
            onAllModels={setAllModels}
            onCategory={(name, visible) => void visRef.current?.dispatch({ t: "category", name, visible })}
            onAllCategories={setAllCategories}
            onIsolate={isolateSelection}
            onHide={hideSelection}
            onXray={toggleXray}
            onReset={resetFilters}
            onDone={closePanels}
          />
        )}
        {panel === "tree" && (
          <TreePanel
            roots={treeRoots}
            loading={treeRoots === null && !treeError}
            error={treeError}
            hidden={(id) => visRef.current?.hidden(id)}
            visRev={visRev}
            names={treeNames}
            selectedKey={pickedKey}
            selectedTitle={pickedTitle}
            onSelect={treeSelect}
            onToggle={treeToggle}
            onIsolate={treeIsolate}
            onProperties={closePanels}
            onClose={closePanels}
          />
        )}
        {panel === "views" && (
          <ViewsPanel
            views={savedViews}
            suggestion={defaultName(savedViews)}
            disabled={phase !== "ready"}
            note={viewsNote}
            onSave={saveCurrentView}
            onRestore={(sv) => void restoreSavedView(sv)}
            onRename={(id, name) => void renameView(viewpointDb, id, name)}
            onDelete={(id) => void deleteView(viewpointDb, id)}
            onClose={closePanels}
          />
        )}
        {panel === "search" && (
          <SearchPanel results={searchRes} busy={searchBusy} selectedKey={pickedKey} selectedTitle={pickedTitle} onQuery={doSearch} onPick={pickSearchRow} onIsolateCategory={(n) => void isolateCategory(n)} onProperties={closePanels} onClose={closePanels} />
        )}

        {picked && !walking && !panel && !measureSheet && (
          <PropertiesSheet state={propsState} localId={picked.localId} point={!!picked.point} onNewTask={() => void newTaskFor(picked)} onIsolate={isolateSelection} onHide={hideSelection} onSectionBox={() => { void boxAroundSelection(); setPanel("section"); }} onClose={() => { viewerRef.current?.clearSelection(); setPicked(null); }} />
        )}

        {(phase === "loading" || phase === "reloading" || phase === "released") && (
          <div className="model-status" data-testid="model-status" data-phase={phase}>
            <p>{phase === "reloading" ? "Reloading model…" : phase === "released" ? "Model released to save memory. It reloads when you return." : "Loading model…"}</p>
          </div>
        )}
        {phase === "failed" && (
          <div className="model-status" data-testid="model-status" data-phase="failed">
            <p className="error">The graphics context keeps getting lost.</p>
            <button type="button" className="btn primary" data-testid="model-retry" onClick={retry}>
              Reload model
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export { EYE_HEIGHT };
