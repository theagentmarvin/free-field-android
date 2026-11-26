import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { Loupe, LOUPE_SIZE } from "./Loupe";
import { loupeSource } from "./loupe";
import { addPoint, canFinish, cancelDraft, emptyDraft, finishDraft, selectTool, undoPoint, type Draft, type DraftResult, type PlanTool } from "./planDraft";
import { angleDeg, formatAngle, formatMeasurement, KIND_LABEL, measurementValue, parseLength, type PlanMeasureKind } from "./planMath";
import { usePlanMeasureData, measureKey, type PlanMeasureStore } from "./planMeasureStore";
import { centroid, formatArea, formatLength, polygonArea, polylineLength, resolvePageScale, scaleBadgeText, scaleFromTwoPoints, segmentLengths, snapToPoints, toMetres, type LengthUnit, type PageScale, type Point } from "./webMath";
import { pageToScreen, screenToPage, type View } from "../plans/viewMath";

const SNAP_PX = 14;
const DEDUPE_PX = 3;
const LOUPE_ZOOM = 3;
const UNITS: LengthUnit[] = ["m", "cm", "mm", "ft", "in"];

export interface PlanMeasureHandle {
  /** One finger is aiming at this plan-local screen point (null: the aim ended without a placement). */
  aim(p: { x: number; y: number } | null): void;
  /** The finger lifted at this point: place it. */
  place(p: { x: number; y: number }): void;
}

interface Props {
  store: PlanMeasureStore;
  planVersionId: string;
  view: View | null;
  size: { width: number; height: number };
  /** Metres per page unit from the plan's calibration (null: none). Page 1 only, like the web. */
  calibrationMpu: number | null;
  planCanvas: () => HTMLCanvasElement | null;
  centerOn: (p: Point) => void;
  /** Measure mode toggled: the viewer routes one finger to aiming while it is on. */
  onActiveChange: (active: boolean) => void;
  /** Markup mode is on: the Measure entry button hides (the modes are exclusive). */
  suspended?: boolean;
}

const kindColour = (k: PlanMeasureKind) => `var(--m-${k})`;

/** Measure tools of the plan viewer: tool bar, draft + stored overlay, loupe, scale dialog and the measurements list. */
export const PlanMeasure = forwardRef<PlanMeasureHandle, Props>(function PlanMeasure({ store, planVersionId, view, size, calibrationMpu, planCanvas, centerOn, onActiveChange, suspended = false }, ref) {
  const key = measureKey(planVersionId, 1);
  const data = usePlanMeasureData(store);
  const rows = data.measurements[key] ?? [];
  const manual = data.scales[key] ?? null;
  const scale: PageScale = useMemo(() => resolvePageScale({ page: 1, manualMetresPerUnit: manual, calibrationMetresPerUnit: calibrationMpu }), [manual, calibrationMpu]);

  const [draft, setDraft] = useState<Draft>(emptyDraft("none"));
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [aim, setAim] = useState<{ x: number; y: number } | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [dialog, setDialog] = useState<{ a: Point; b: Point } | null>(null);
  const [typed, setTyped] = useState("");
  const [unit, setUnit] = useState<LengthUnit>("m");

  const active = draft.tool !== "none";
  useEffect(() => onActiveChange(active && !dialog), [active, dialog, onActiveChange]);

  const viewRef = useRef(view);
  viewRef.current = view;
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  /** The page point a screen point means: snapped to an existing vertex (draft or stored) when one is near. */
  const resolve = useCallback(
    (s: { x: number; y: number }): { page: Point; snapped: boolean } | null => {
      const v = viewRef.current;
      if (!v) return null;
      const raw = screenToPage(v, s);
      const cands: Point[] = [...draftRef.current.points];
      for (const m of rowsRef.current) cands.push(...m.points);
      const r = snapToPoints(raw, cands, SNAP_PX / v.zoom);
      return { page: r.point, snapped: r.snapped };
    },
    [],
  );

  const commitResult = useCallback(
    (r: DraftResult) => {
      if (r.type === "done") {
        store.add(key, { kind: r.kind, points: r.points });
        setDraft(r.draft);
      } else if (r.type === "scale") {
        setDialog({ a: r.a, b: r.b });
        setTyped("");
        setDraft(r.draft);
      } else setDraft(r.draft);
    },
    [store, key],
  );

  useImperativeHandle(
    ref,
    () => ({
      aim: (p) => setAim(p),
      place: (p) => {
        setAim(null);
        const res = resolve(p);
        const v = viewRef.current;
        if (!res || !v) return;
        commitResult(addPoint(draftRef.current, res.page, DEDUPE_PX / v.zoom));
      },
    }),
    [resolve, commitResult],
  );

  // Leave measure mode when the plan version changes.
  useEffect(() => {
    setDraft(emptyDraft("none"));
    setAim(null);
    setDialog(null);
    setListOpen(false);
  }, [planVersionId]);

  const pickTool = (t: PlanTool) => {
    setAim(null);
    setDraft(selectTool(t));
  };
  const applyScale = () => {
    if (!dialog) return;
    const n = parseLength(typed);
    const s = n === null ? null : scaleFromTwoPoints(dialog.a, dialog.b, toMetres(n, unit));
    if (!s || s.metresPerUnit === null) return;
    store.setScale(key, s.metresPerUnit);
    setDialog(null);
    setDraft(selectTool("length"));
  };

  const aimed = aim ? resolve(aim) : null;
  const live: Point[] = aimed ? [...draft.points, aimed.page] : draft.points;
  const liveText = (() => {
    if (draft.tool === "none" || draft.tool === "scale") return "";
    if (live.length < (draft.tool === "length" ? 2 : 3)) return "";
    return formatMeasurement({ kind: draft.tool, points: live }, scale);
  })();

  const loupeDraw = useCallback(
    (ctx: CanvasRenderingContext2D, w: number, h: number) => {
      const c = planCanvas();
      if (!c || !aim) return;
      const s = loupeSource(aim, { w: size.width, h: size.height }, { w: c.width, h: c.height }, LOUPE_SIZE, LOUPE_ZOOM);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(c, s.sx, s.sy, s.sw, s.sw, 0, 0, w, h);
    },
    [aim, planCanvas, size],
  );

  const sp = (p: Point) => (view ? pageToScreen(view, p) : { x: 0, y: 0 });
  const label = (x: number, y: number, text: string, kind: PlanMeasureKind | "draft", extra?: string) => (
    <text key={`${x}|${y}|${text}${extra ?? ""}`} className={`pm-label${kind === "draft" ? " is-draft" : ""}`} x={x} y={y} textAnchor="middle">
      {text}
    </text>
  );

  const shape = (kind: PlanMeasureKind, pts: readonly Point[], id: string, draftShape = false) => {
    if (!view || pts.length === 0) return null;
    const s = pts.map(sp);
    const colour = kindColour(kind);
    const d = s.map((q, i) => `${i ? "L" : "M"}${q.x.toFixed(1)} ${q.y.toFixed(1)}`).join(" ");
    const closed = kind === "area" && s.length >= 3;
    const out = [];
    if (kind === "area" && s.length >= 3) out.push(<path key="fill" className="pm-fill" d={`${d} Z`} style={{ fill: colour }} />);
    if (kind === "angle" && s.length >= 3) {
      // arc at the vertex between the two rays
      const r = 26;
      const a0 = Math.atan2(s[0].y - s[1].y, s[0].x - s[1].x);
      const a1 = Math.atan2(s[2].y - s[1].y, s[2].x - s[1].x);
      let da = a1 - a0;
      while (da > Math.PI) da -= 2 * Math.PI;
      while (da < -Math.PI) da += 2 * Math.PI;
      const p0 = { x: s[1].x + r * Math.cos(a0), y: s[1].y + r * Math.sin(a0) };
      const p1 = { x: s[1].x + r * Math.cos(a0 + da), y: s[1].y + r * Math.sin(a0 + da) };
      out.push(<path key="arc" className="pm-line" d={`M${p0.x.toFixed(1)} ${p0.y.toFixed(1)} A${r} ${r} 0 0 ${da > 0 ? 1 : 0} ${p1.x.toFixed(1)} ${p1.y.toFixed(1)}`} style={{ stroke: colour }} />);
    }
    out.push(<path key="line" className={`pm-line${draftShape ? " is-draft" : ""}`} d={closed ? `${d} Z` : d} style={{ stroke: colour }} />);
    s.forEach((q, i) => out.push(<circle key={`v${i}`} className="pm-vertex" cx={q.x} cy={q.y} r={5} style={{ stroke: colour }} />));
    // labels
    if (kind === "length" && pts.length >= 2) {
      const segs = segmentLengths(pts);
      if (segs.length > 1) segs.forEach((l, i) => out.push(label((s[i].x + s[i + 1].x) / 2, (s[i].y + s[i + 1].y) / 2 - 8, formatLength(l, scale), draftShape ? "draft" : kind, `s${i}`)));
      const last = s[s.length - 1];
      out.push(label(last.x, last.y - 14, `${segs.length > 1 ? "Σ " : ""}${formatLength(polylineLength(pts), scale)}`, draftShape ? "draft" : kind, "t"));
    } else if (kind === "area" && pts.length >= 3) {
      const c = sp(centroid(pts));
      out.push(label(c.x, c.y, formatArea(polygonArea(pts), scale), draftShape ? "draft" : kind));
    } else if (kind === "angle" && pts.length >= 3) {
      out.push(label(s[1].x, s[1].y - 34, formatAngle(angleDeg(pts[0], pts[1], pts[2])), draftShape ? "draft" : kind));
    }
    return <g key={id} data-testid={draftShape ? "measure-draft" : "measure-shape"} data-id={id} data-kind={kind}>{out}</g>;
  };

  const focus = (pts: readonly Point[]) => {
    if (pts.length) centerOn(centroid(pts));
    setListOpen(false);
  };

  const hasScale = scale.metresPerUnit !== null;
  const tools: Array<{ id: PlanTool; label: string }> = [
    { id: "length", label: "Length" },
    { id: "area", label: "Area" },
    { id: "angle", label: "Angle" },
    { id: "scale", label: "Set scale" },
  ];

  return (
    <>
      {view && (
        <svg className="plan-measure-svg" width={size.width} height={size.height} data-testid="measure-overlay" data-count={rows.length} aria-hidden="true">
          {rows.map((m) => shape(m.kind, m.points, m.id))}
          {draft.tool !== "none" && draft.tool !== "scale" && draft.points.length > 0 && shape(draft.tool, live, "draft", true)}
          {draft.tool === "scale" && draft.points.length > 0 && (
            <g data-testid="measure-scale-draft">
              <path className="pm-line is-draft" d={[...live].map(sp).map((q, i) => `${i ? "L" : "M"}${q.x.toFixed(1)} ${q.y.toFixed(1)}`).join(" ")} style={{ stroke: "var(--accent)" }} />
              {draft.points.map((p, i) => <circle key={i} className="pm-vertex" cx={sp(p).x} cy={sp(p).y} r={5} style={{ stroke: "var(--accent)" }} />)}
            </g>
          )}
          {dialog && (
            <g>
              <path className="pm-line" d={`M${sp(dialog.a).x} ${sp(dialog.a).y}L${sp(dialog.b).x} ${sp(dialog.b).y}`} style={{ stroke: "var(--accent)" }} />
              {[dialog.a, dialog.b].map((p, i) => <circle key={i} className="pm-vertex" cx={sp(p).x} cy={sp(p).y} r={5} style={{ stroke: "var(--accent)" }} />)}
            </g>
          )}
          {aim && aimed && (
            <g data-testid="measure-reticle" data-snapped={aimed.snapped ? "1" : "0"}>
              <circle className={`pm-reticle${aimed.snapped ? " is-snap" : ""}`} cx={sp(aimed.page).x} cy={sp(aimed.page).y} r={aimed.snapped ? 9 : 6} />
            </g>
          )}
        </svg>
      )}
      {aim && <Loupe aim={aim} bounds={{ w: size.width, h: size.height }} draw={loupeDraw} />}

      {!(suspended && !active && !dialog) && (
      <div className="plan-measure-bar" data-nogesture data-testid="measure-bar" data-tool={draft.tool}>
        {!active && !dialog ? (
          <div className="pm-row">
            <button type="button" className="btn primary" data-testid="measure-toggle" onClick={() => pickTool("length")}>
              Measure
            </button>
            {rows.length > 0 && (
              <button type="button" className="btn" data-testid="measure-list-open" onClick={() => setListOpen(true)}>
                Measurements ({rows.length})
              </button>
            )}
          </div>
        ) : (
          <>
            {!hasScale && !dialog && (
              <div className="pm-hint" data-testid="measure-scale-hint">
                <span>No scale on this plan: values read in page points.</span>
                <button type="button" className="btn small" data-testid="measure-scale-hint-btn" onClick={() => pickTool("scale")}>
                  Set scale from a known distance
                </button>
              </div>
            )}
            <div className="pm-row pm-tools" role="toolbar" aria-label="Measure tools">
              {tools.map((t) => (
                <button key={t.id} type="button" className={`chip${draft.tool === t.id ? " is-on" : ""}`} data-testid={`measure-tool-${t.id}`} aria-pressed={draft.tool === t.id} onClick={() => pickTool(t.id)}>
                  {t.label}
                </button>
              ))}
              <span className="pm-badge" data-testid="measure-scale-badge" data-source={scale.source}>
                {scaleBadgeText(scale)}
              </span>
            </div>
            <div className="pm-row">
              <span className="pm-live" data-testid="measure-live" aria-live="polite">
                {draft.tool === "scale" ? (draft.points.length === 0 ? "Tap the first end of a known distance" : "Tap the second end") : liveText || (draft.points.length === 0 ? "Touch and hold to aim, lift to place a point" : `${draft.points.length} point${draft.points.length === 1 ? "" : "s"}`)}
              </span>
              <button type="button" className="btn small" data-testid="measure-undo" disabled={draft.points.length === 0} onClick={() => setDraft(undoPoint(draftRef.current))}>
                Undo
              </button>
              <button
                type="button"
                className="btn small primary"
                data-testid="measure-finish"
                disabled={!canFinish(draft)}
                onClick={() => {
                  const r = finishDraft(draftRef.current);
                  if (r) commitResult(r);
                }}
              >
                Finish
              </button>
              <button type="button" className="btn small" data-testid="measure-cancel" onClick={() => setDraft(cancelDraft(draftRef.current))}>
                {draft.points.length > 0 ? "Cancel" : "Done"}
              </button>
              <button type="button" className="btn small" data-testid="measure-list-open" onClick={() => setListOpen(true)}>
                List ({rows.length})
              </button>
            </div>
          </>
        )}
      </div>
      )}

      {dialog && (
        <div className="plan-measure-dialog" data-nogesture data-testid="measure-scale-dialog" role="dialog" aria-label="Set scale">
          <p>
            <strong>Set scale</strong>
            <br />
            <span className="muted">How long is the distance you marked?</span>
          </p>
          <div className="pm-row">
            <input
              className="field"
              data-testid="measure-scale-input"
              inputMode="decimal"
              autoFocus
              value={typed}
              placeholder="Length"
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && applyScale()}
            />
            <select className="field" data-testid="measure-scale-unit" value={unit} onChange={(e) => setUnit(e.target.value as LengthUnit)} aria-label="Unit">
              {UNITS.map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </select>
          </div>
          <div className="pm-row">
            <button type="button" className="btn" data-testid="measure-scale-cancel" onClick={() => { setDialog(null); setDraft(selectTool("length")); }}>
              Cancel
            </button>
            <button type="button" className="btn primary" data-testid="measure-scale-apply" disabled={parseLength(typed) === null} onClick={applyScale}>
              Apply
            </button>
          </div>
        </div>
      )}

      {listOpen && (
        <aside className="plan-measure-sheet" data-nogesture data-testid="measure-sheet" aria-label="Measurements">
          <header className="model-sheet-head">
            <strong className="grow">Measurements</strong>
            <button type="button" className="btn small" data-testid="measure-sheet-close" onClick={() => setListOpen(false)} aria-label="Close measurements">
              ✕
            </button>
          </header>
          <div className="model-sheet-body">
            <p className="muted small-text" data-testid="measure-sheet-scale">
              {scaleBadgeText(scale)}
              {manual !== null && (
                <>
                  {" · "}
                  <button type="button" className="link" data-testid="measure-scale-reset" onClick={() => store.setScale(key, null)}>
                    Reset scale
                  </button>
                </>
              )}
            </p>
            {rows.length === 0 && <p className="muted">No measurements on this plan yet.</p>}
            <ul className="pm-list">
              {rows.map((m, i) => (
                <li key={m.id} data-testid="measure-row" data-kind={m.kind} data-value={measurementValue(m)} data-text={formatMeasurement(m, scale)}>
                  <button type="button" className="pm-row-main" data-testid="measure-row-focus" onClick={() => focus(m.points)}>
                    <span className="pm-swatch" style={{ background: kindColour(m.kind) }} />
                    <span className="grow">
                      {KIND_LABEL[m.kind]} {rows.slice(0, i + 1).filter((r) => r.kind === m.kind).length}
                    </span>
                    <strong>{formatMeasurement(m, scale)}</strong>
                  </button>
                  <button type="button" className="btn small" data-testid="measure-row-delete" aria-label={`Delete ${KIND_LABEL[m.kind]}`} onClick={() => store.remove(key, m.id)}>
                    ✕
                  </button>
                </li>
              ))}
            </ul>
            {rows.length > 0 && (
              <button type="button" className="btn danger" data-testid="measure-clear" onClick={() => store.clear(key)}>
                Clear all
              </button>
            )}
          </div>
        </aside>
      )}
    </>
  );
});
