import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useProjectId } from "@ff/auth";
import { usePanelTasks } from "@ff/tasks-react";
import { BuildingModel } from "../pages/ModelPage";
import { pinsForPlan } from "../plans/pins";
import { usePlanRecord } from "../plans/usePlans";
import { newTaskUrl } from "../plans/anchor";
import type { PlanManifest } from "../plans/manifest";
import { levelIndexFor } from "../model/walkLevels";
import { testHooksEnabled } from "../dev/flag";
import { PlanPane } from "./PlanPane";
import { clampRatio, loadLayoutPrefs, ratioFromDrag, saveLayoutPrefs, splitDirection, type SplitDirection } from "./layout";
import type { LinkviewBinding, LinkviewControl, LinkWalker } from "./binding";
import { choosePlan, levelOf, modelPinsFromPlan, planPinsFromModel, plansForStorey, type CalibratedPlan } from "./plans";
import { linkviewPath, parseLinkview } from "./route";
import { bearingFromYaw, clampToPage, insidePage, markerFromWalker, pageHeadingFromYaw, seedWalker, walkerChanged, walkerFromPage, yawFromPageHeading, type PagePt } from "./sync";
import { useLinkData } from "./useLinkPlans";
import { loadOverlayPrefs, planAlpha, saveOverlayPrefs, type OverlayPrefs } from "./overlay";
import "./linkview.css";

const DIVIDER_PX = 24;

declare global {
  interface Window {
    __ffmLinkview?: { state(): Record<string, unknown> };
  }
}

/**
 * Route `/linkview/:buildingId`: the calibrated plan and the 3D model side by side (landscape) or stacked (portrait). The marker on the plan is the
 * camera of the 3D pane (first person, eye height on the plan's storey); tapping the plan moves the camera there, dragging the marker's handle
 * turns it, walking in 3D moves the marker.
 */
export function LinkviewPage() {
  const { buildingId = "" } = useParams();
  const projectId = useProjectId() ?? "";
  const data = useLinkData(projectId, buildingId);
  const [search] = useSearchParams();
  const first = useRef(parseLinkview(search));
  if (data === undefined) return <p className="muted pad">Loading…</p>;
  if (data.plans.length === 0)
    return (
      <div className="center-screen" data-testid="lv-none">
        <p>No plan of this building is calibrated to a level yet.</p>
        <p className="muted">Calibrate a plan to a level in FreeField on the web and sync; it appears here, also offline.</p>
        <div className="row" style={{ justifyContent: "center", width: "auto" }}>
          <Link to="/plans" className="btn">
            Plans
          </Link>
          <Link to={`/model/${encodeURIComponent(buildingId)}`} className="btn primary">
            3D view
          </Link>
        </div>
      </div>
    );
  return <LinkviewBody key={buildingId} buildingId={buildingId} projectId={projectId} data={data} first={first.current} />;
}

function LinkviewBody({ buildingId, projectId, data, first }: { buildingId: string; projectId: string; data: NonNullable<ReturnType<typeof useLinkData>>; first: ReturnType<typeof parseLinkview> }) {
  const navigate = useNavigate();
  const tasks = usePanelTasks();
  const { plans, levels, storeys } = data;

  // ── what is shown: the walker's level, and the plan chosen for it ──
  const start = useRef<CalibratedPlan | null>(null);
  if (start.current === null) start.current = choosePlan(plans, { plan: first.plan, storey: first.storey });
  const startPlan = start.current!;
  const [storey, setStorey] = useState(startPlan.storeyName);
  const [prefPdf, setPrefPdf] = useState(startPlan.pdfFileId);
  const plan: CalibratedPlan | null = useMemo(() => {
    const here = plansForStorey(plans, storey);
    return here.find((p) => p.pdfFileId === prefPdf) ?? here[0] ?? null;
  }, [plans, storey, prefPdf]);
  const level = useMemo(() => levelOf(storeys, storey), [storeys, storey]);
  const floorY = level?.elevation ?? 0;

  // ── the walker (the 3D camera), mirrored here for the marker ──
  const initial = useRef<LinkWalker>(null as never);
  if (initial.current === null) {
    const lv = levelOf(storeys, startPlan.storeyName);
    const fy = lv?.elevation ?? 0;
    const s = first.start;
    initial.current = s ? { x: s.x, z: s.z, floorY: fy, yaw: s.bearingDeg !== null ? ((s.bearingDeg * Math.PI) / 180) + Math.PI / 2 : seedWalker(startPlan.calibration, fy).yaw } : seedWalker(startPlan.calibration, fy);
  }
  const [walker, setWalker] = useState<LinkWalker>(initial.current);
  const shown = useRef<LinkWalker>(initial.current);
  const storeyRef = useRef(storey);
  storeyRef.current = storey;
  const levelsRef = useRef(levels);
  levelsRef.current = levels;
  const control = useRef<LinkviewControl | null>(null);
  const onWalker = useCallback((w: LinkWalker) => {
    if (walkerChanged(shown.current, w)) {
      shown.current = w;
      setWalker(w);
    }
    // A level change in the 3D pane (its level picker). Levels at the same elevation keep the current name.
    const cur = levelsRef.current.find((l) => l.name === storeyRef.current);
    if (cur && Math.abs(cur.elevation - w.floorY) < 1e-6) return;
    const i = levelIndexFor(levelsRef.current, w.floorY);
    const name = i >= 0 ? levelsRef.current[i].name : null;
    if (name && name !== storeyRef.current) setStorey(name);
  }, []);
  const binding = useMemo<LinkviewBinding>(() => ({ initial: initial.current, onChange: onWalker, controlRef: control }), [onWalker]);

  // ── the plan pane ──
  const rec = usePlanRecord(plan?.pdfFileId ?? "");
  const [manifest, setManifest] = useState<PlanManifest | null>(null);
  const page = useMemo(() => (manifest && rec?.version?.id === manifest.planVersionId ? { width: manifest.pageWidth, height: manifest.pageHeight } : null), [manifest, rec?.version?.id]);
  const params = plan?.calibration.transformParams ?? null;
  const rawMarker = params ? markerFromWalker(params, walker) : null;
  const outside = !!(rawMarker && page && !insidePage(rawMarker.page, page));
  const marker = rawMarker && page ? { ...rawMarker, page: clampToPage(rawMarker.page, page) } : rawMarker;

  const place = useCallback(
    (pt: PagePt) => {
      if (!params) return;
      const w = walkerFromPage(params, floorY, page ? clampToPage(pt, page) : pt, pageHeadingFromYaw(params, shown.current.yaw));
      shown.current = w;
      setWalker(w);
      control.current?.place(w);
    },
    [params, floorY, page],
  );
  const turn = useCallback(
    (heading: number) => {
      if (!params) return;
      const yaw = yawFromPageHeading(params, heading);
      shown.current = { ...shown.current, yaw };
      setWalker(shown.current);
      control.current?.place({ yaw });
    },
    [params],
  );
  const chooseStorey = useCallback(
    (name: string, pdf?: string) => {
      const lv = levelOf(storeys, name);
      if (!lv) return;
      setStorey(name);
      if (pdf) setPrefPdf(pdf);
      shown.current = { ...shown.current, floorY: lv.elevation };
      setWalker(shown.current);
      control.current?.place({ floorY: lv.elevation });
    },
    [storeys],
  );
  const toPlan = useCallback(() => {
    if (!plan) return;
    const w = seedWalker(plan.calibration, floorY);
    shown.current = w;
    setWalker(w);
    control.current?.place(w);
  }, [plan, floorY]);

  // ── task pins in both panes ──
  const ownPins = useMemo(() => (rec?.version && plan ? pinsForPlan(tasks, plan.pdfFileId, rec.version.id, 1, rec.versions) : []), [tasks, rec, plan]);
  const planPins = useMemo(() => {
    if (!rec?.version || !plan || !page) return ownPins;
    const fromModel = planPinsFromModel(tasks, { calibration: plan.calibration, page, floorY, levels, buildingId, pdfFileId: plan.pdfFileId, versionId: rec.version.id });
    return [...ownPins, ...fromModel];
  }, [tasks, rec, plan, page, floorY, levels, buildingId, ownPins]);
  const extraPins = useMemo(() => (plan && page ? modelPinsFromPlan(ownPins, { calibration: plan.calibration, page, floorY, buildingId }, new Set()) : []), [plan, page, floorY, buildingId, ownPins]);

  // ── layout: orientation, divider, swap ──
  const boxRef = useRef<HTMLDivElement>(null);
  const [dir, setDir] = useState<SplitDirection>("row");
  const [prefs, setPrefs] = useState(loadLayoutPrefs);
  const [ghost, setGhost] = useState<number | null>(null);
  const [ov, setOv] = useState<OverlayPrefs>(loadOverlayPrefs);
  const commitOv = (p: OverlayPrefs) => {
    setOv(p);
    saveOverlayPrefs(p);
  };
  const overlay = ov.mode === "overlay";
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const apply = () => setDir(splitDirection(el.clientWidth, el.clientHeight));
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const total = () => (dir === "row" ? (boxRef.current?.clientWidth ?? 0) : (boxRef.current?.clientHeight ?? 0));
  const dragShare = (e: React.PointerEvent) => {
    const r = boxRef.current!.getBoundingClientRect();
    const pos = dir === "row" ? e.clientX - r.left : e.clientY - r.top;
    return { pos, share: ratioFromDrag(pos, total(), DIVIDER_PX) };
  };
  const dragging = useRef<number | null>(null);
  const commitPrefs = (p: typeof prefs) => {
    setPrefs(p);
    saveLayoutPrefs(p);
  };
  // `ratio` is the plan's share whichever side it sits on.
  const planShare = clampRatio(prefs.ratio, total() - DIVIDER_PX);

  // ── keep the URL at the walker (so Back from a task, or a restored app, lands here again) ──
  useEffect(() => {
    if (!plan) return;
    const t = window.setTimeout(() => {
      navigate(linkviewPath(buildingId, { plan: plan.pdfFileId, storey, start: { x: walker.x, z: walker.z, bearingDeg: (bearingFromYaw(walker.yaw) * 180) / Math.PI } }), { replace: true });
    }, 700);
    return () => window.clearTimeout(t);
  }, [navigate, buildingId, plan, storey, walker]);

  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!testHooksEnabled()) return;
    window.__ffmLinkview = {
      state: () => ({ storey, plan: plan?.pdfFileId ?? null, params, page, walker: shown.current, dir, planShare, swapped: prefs.swapped, outside, floorY, mode: ov.mode, opacity: ov.opacity, touch: ov.touch }),
    };
    return () => {
      delete window.__ffmLinkview;
    };
  });

  const storeysWithPlan = useMemo(() => [...new Set(plans.map((p) => p.storeyName))], [plans]);
  const here = plan ? plansForStorey(plans, storey) : [];
  const back = () => (window.history.length > 1 ? navigate(-1) : navigate(`/model/${encodeURIComponent(buildingId)}`));

  return (
    <div className="lv-page" data-testid="lv-page" data-building={buildingId} data-dir={dir} data-storey={storey} data-plan={plan?.pdfFileId ?? ""} data-swapped={prefs.swapped ? "1" : "0"} data-mode={ov.mode}>
      <div className="lv-bar">
        <button type="button" className="back lv-back" data-testid="lv-back" onClick={back}>
          ‹ Back
        </button>
        <div className="lv-levels" data-testid="lv-levels" role="group" aria-label="Level">
          {storeysWithPlan.map((n) => (
            <button key={n} type="button" className={`chip${n === storey ? " is-on" : ""}`} data-testid="lv-level" data-storey={n} aria-pressed={n === storey} onClick={() => chooseStorey(n)}>
              {n}
            </button>
          ))}
          {!storeysWithPlan.includes(storey) && (
            <span className="chip is-on is-nopan" data-testid="lv-level-noplan" data-storey={storey}>
              {storey} · no plan
            </span>
          )}
        </div>
        {here.length > 1 && (
          <select className="field lv-plan-select" data-testid="lv-plan-select" aria-label="Plan" value={plan?.pdfFileId} onChange={(e) => chooseStorey(storey, e.target.value)}>
            {here.map((p) => (
              <option key={p.pdfFileId} value={p.pdfFileId}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        <span className="lv-bar-slot" ref={setSlot} data-testid="lv-bar-slot" />
        <div className="lv-modes" role="group" aria-label="Layout" data-testid="lv-modes">
          <button type="button" className={`chip${!overlay ? " is-on" : ""}`} data-testid="lv-mode-split" aria-pressed={!overlay} onClick={() => commitOv({ ...ov, mode: "split" })}>
            Split
          </button>
          <button type="button" className={`chip${overlay ? " is-on" : ""}`} data-testid="lv-mode-overlay" aria-pressed={overlay} onClick={() => commitOv({ ...ov, mode: "overlay" })}>
            Overlay
          </button>
        </div>
        {!overlay && (
          <button type="button" className="btn small" data-testid="lv-swap" onClick={() => commitPrefs({ ...prefs, swapped: !prefs.swapped })}>
            ⇄ Swap
          </button>
        )}
      </div>
      {first.plan && first.plan !== startPlan.pdfFileId && (
        <p className="lv-note" data-testid="lv-note" role="status">
          The plan you opened is not calibrated to a level of this building, so it cannot be linked to the 3D view. Showing {startPlan.name} instead.
        </p>
      )}
      <div className="lv-split" ref={boxRef} data-dir={dir} data-mode={ov.mode} data-touch={ov.touch}>
        <div className="lv-pane lv-plan" data-testid="lv-plan-pane" data-alpha={planAlpha(ov)} style={{ opacity: planAlpha(ov), flexBasis: `calc((100% - ${DIVIDER_PX}px) * ${planShare})`, order: prefs.swapped ? 2 : 0 }}>
          {plan ? (
            <>
              <PlanPane
                rec={rec}
                pins={planPins}
                marker={marker}
                onPlace={place}
                onTurn={turn}
                onPinTap={(id) => navigate(`/tasks/${id}`)}
                onNewTask={(versionId, uv) => navigate(`${newTaskUrl({ pdfFileId: plan.pdfFileId, planVersionId: versionId, page: 1, uv })}&back=${encodeURIComponent(linkviewPath(buildingId, { plan: plan.pdfFileId, storey, start: { x: walker.x, z: walker.z, bearingDeg: (bearingFromYaw(walker.yaw) * 180) / Math.PI } }))}`)}
                onManifest={setManifest}
              />
              {outside && (
                <div className="lv-outside" data-testid="lv-outside" role="status">
                  <span className="grow">The camera is outside this plan.</span>
                  <button type="button" className="btn small" data-testid="lv-outside-go" onClick={toPlan}>
                    Go to the plan
                  </button>
                </div>
              )}
            </>
          ) : (
            <div className="center-screen" data-testid="lv-no-plan" data-storey={storey}>
              <p>
                No plan is calibrated to <strong>{storey}</strong>.
              </p>
              <p className="muted">The 3D view keeps working. Pick a level that has a plan to see the camera on it.</p>
              <div className="lv-chiprow">
                {storeysWithPlan.map((n) => (
                  <button key={n} type="button" className="btn" data-testid="lv-no-plan-level" data-storey={n} onClick={() => chooseStorey(n)}>
                    {n}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        <div
          className={`lv-divider${ghost !== null ? " is-dragging" : ""}`}
          data-testid="lv-divider"
          data-nogesture
          role="separator"
          aria-orientation={dir === "row" ? "vertical" : "horizontal"}
          aria-label="Resize the plan and the 3D view"
          style={{ flexBasis: DIVIDER_PX, order: 1 }}
          onPointerDown={(e) => {
            dragging.current = e.pointerId;
            e.currentTarget.setPointerCapture(e.pointerId);
            setGhost(dragShare(e).pos);
          }}
          onPointerMove={(e) => {
            if (dragging.current === e.pointerId) setGhost(dragShare(e).pos);
          }}
          onPointerUp={(e) => {
            if (dragging.current !== e.pointerId) return;
            dragging.current = null;
            const { share } = dragShare(e);
            setGhost(null);
            commitPrefs({ ...prefs, ratio: prefs.swapped ? 1 - share : share }); // the share is the first pane on screen's
          }}
          onPointerCancel={() => {
            dragging.current = null;
            setGhost(null);
          }}
          onDoubleClick={() => commitPrefs({ ...prefs, ratio: 0.5 })}
        >
          <span className="lv-grip" />
        </div>
        <div className="lv-pane lv-model" data-testid="lv-model-pane" style={{ order: prefs.swapped ? 0 : 2 }}>
          <Suspense fallback={<p className="muted pad">Loading viewer…</p>}>
            <BuildingModel projectId={projectId} buildingId={buildingId} taskId={null} tasks={tasks} toolbarSlot={slot} linkview={binding} extraPins={extraPins} />
          </Suspense>
        </div>
        {overlay && (
          <div className="lv-overlay-ctl" data-testid="lv-overlay-ctl" data-nogesture>
            <label className="lv-opacity">
              <span>Plan</span>
              <input type="range" min={0} max={100} step={1} value={ov.opacity} data-testid="lv-opacity" aria-label="Plan opacity" aria-valuetext={`${ov.opacity}%`} onChange={(e) => commitOv({ ...ov, opacity: Number(e.target.value) })} />
              <output data-testid="lv-opacity-value">{ov.opacity}%</output>
            </label>
            <div className="lv-touch" role="group" aria-label="Touch controls">
              <button type="button" className={`chip${ov.touch === "plan" ? " is-on" : ""}`} data-testid="lv-touch-plan" aria-pressed={ov.touch === "plan"} onClick={() => commitOv({ ...ov, touch: "plan" })}>
                Move on plan
              </button>
              <button type="button" className={`chip${ov.touch === "3d" ? " is-on" : ""}`} data-testid="lv-touch-3d" aria-pressed={ov.touch === "3d"} onClick={() => commitOv({ ...ov, touch: "3d" })}>
                Use 3D
              </button>
            </div>
          </div>
        )}
        {ghost !== null && <div className="lv-ghost" data-dir={dir} style={dir === "row" ? { left: ghost } : { top: ghost }} />}
      </div>
    </div>
  );
}
