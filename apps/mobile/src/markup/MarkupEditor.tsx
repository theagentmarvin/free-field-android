import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { ConfirmDialog } from "../shell/ConfirmDialog";
import { setBackGuard } from "../platform/backGuard";
import { fitView, resizeView, screenToPage, zoomAbout, zoomLimits, type View } from "../plans/viewMath";
import { clamp01, markupPath, strokeFor, smoothPath, textBox, TEXT_LINE_HEIGHT, HIGHLIGHT_OPACITY, type Pt } from "./geometry";
import { IconArrow, IconCloud, IconEllipse, IconHighlight, IconPen, IconRect, IconRedo, IconText, IconUndo } from "./icons";
import { InkHistory, INK_PRESETS, type Ink } from "./ink";
import { flattenInk, type Flattened } from "./inkRender";
import { DEFAULT_COLOUR, MARKUP_COLOURS } from "./palette";
import { isFreehandTool, isPalmContact, isTwoPointTool, strokeToShape, textShape, twoPointShape } from "./tools";
import { EditorGesture, type GestureEvent } from "./viewGesture";
import "./markupEditor.css";

export type EditorTool = "pen" | "highlight" | "arrow" | "rect" | "ellipse" | "cloud" | "text";

const TOOLS: ReadonlyArray<{ id: EditorTool; label: string; icon: ReactNode }> = [
  { id: "pen", label: "Pen", icon: <IconPen /> },
  { id: "highlight", label: "Highlighter", icon: <IconHighlight /> },
  { id: "arrow", label: "Arrow", icon: <IconArrow /> },
  { id: "rect", label: "Rectangle", icon: <IconRect /> },
  { id: "ellipse", label: "Ellipse", icon: <IconEllipse /> },
  { id: "cloud", label: "Cloud", icon: <IconCloud /> },
  { id: "text", label: "Text", icon: <IconText /> },
];

const MAX_ZOOM_FACTOR = 8; // times the fitted zoom
const MARGIN = 10;
const TAP_SLOP = 8;
const MAX_TEXT = 200;

const newId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 10);

export interface MarkupEditorProps {
  /** The captured picture (JPEG). The drawing is laid over it and burned in on Accept. */
  image: Blob;
  /** Called with the flattened picture; resolve when it is saved. A rejection keeps the editor open with the message. */
  onAccept(flat: Flattened): Promise<void>;
  /** The user discarded the markup (confirmed when there is anything drawn). */
  onCancel(): void;
  title?: string;
}

/**
 * Full-screen annotation of one picture: freehand pen and highlighter, arrow, rectangle, ellipse, cloud and text, six colours,
 * three widths, undo and redo. ONE finger draws, TWO fingers pan and zoom. Accept flattens the picture; Cancel discards.
 * The picture is never edited again after it is saved (the caller stores the flattened JPEG).
 */
export function MarkupEditor({ image, onAccept, onCancel, title = "Markup" }: MarkupEditorProps) {
  const history = useMemo(() => new InkHistory(), []);
  useSyncExternalStore(history.subscribe, history.getVersion);

  const stageRef = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [page, setPage] = useState<{ width: number; height: number } | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [view, setView] = useState<View | null>(null);
  const [tool, setTool] = useState<EditorTool>("pen");
  const [colour, setColour] = useState(DEFAULT_COLOUR);
  const [presetId, setPresetId] = useState<"thin" | "medium" | "thick">("medium");
  const [styleOpen, setStyleOpen] = useState(false);
  const [pen, setPen] = useState<Pt[] | null>(null);
  const [drag, setDrag] = useState<{ a: Pt; b: Pt } | null>(null);
  const [textAt, setTextAt] = useState<{ at: Pt; value: string } | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hintGone, setHintGone] = useState(false);

  const preset = INK_PRESETS.find((p) => p.id === presetId) ?? INK_PRESETS[1];

  // The picture as an object URL (released with the editor).
  useEffect(() => {
    const u = URL.createObjectURL(image);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [image]);

  // Viewport size (rotation, keyboard) and the fitted view.
  const fittedRef = useRef(true);
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setSize((s) => (Math.abs(s.width - r.width) < 0.5 && Math.abs(s.height - r.height) < 0.5 ? s : { width: r.width, height: r.height }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const lastSize = useRef(size);
  useEffect(() => {
    if (!page || size.width < 10 || size.height < 10) return;
    setView((v) => {
      const old = lastSize.current;
      lastSize.current = size;
      if (!v || fittedRef.current) return fitView(page, size, 0, MARGIN);
      return old.width > 10 ? resizeView(v, old, size) : fitView(page, size, 0, MARGIN);
    });
  }, [page, size]);

  const limits = useMemo(() => (page && size.width > 10 ? zoomLimits(page, size, 0, 1) : null), [page, size]);
  const maxZoom = limits ? limits.fit * MAX_ZOOM_FACTOR : 1;
  const zoomed = !!view && !!limits && view.zoom > limits.fit * 1.02;

  // Latest values for the native pointer handlers.
  const R = useRef({ view, tool, colour, preset, page, size, limits, maxZoom });
  R.current = { view, tool, colour, preset, page, size, limits, maxZoom };

  const gesture = useRef(new EditorGesture());
  const penPts = useRef<Pt[]>([]);
  const dragStart = useRef<Pt | null>(null);
  const downAt = useRef<Pt | null>(null);

  const toPage = (x: number, y: number): Pt => screenToPage(R.current.view!, { x, y });

  const commitInk = useCallback(
    (ink: Omit<Ink, "id">) => {
      history.add({ id: newId(), ...ink });
      setHintGone(true);
      setError(null);
    },
    [history],
  );

  const applyEvents = useCallback(
    (evs: GestureEvent[]) => {
      for (const ev of evs) {
        const { view: v, tool: t, page: pg, colour: c, preset: pr } = R.current;
        if (!v || !pg) continue;
        if (ev.type === "nav") {
          fittedRef.current = false;
          const lim = R.current.limits;
          setView((cur) => {
            if (!cur || !lim) return cur;
            const z = ev.scale === 1 ? cur : zoomAbout(cur, ev.scale, { x: ev.cx, y: ev.cy }, lim.fit * 0.9, R.current.maxZoom);
            return { ...z, tx: z.tx + ev.dx, ty: z.ty + ev.dy };
          });
        } else if (ev.type === "draw-cancel") {
          penPts.current = [];
          dragStart.current = null;
          downAt.current = null;
          setPen(null);
          setDrag(null);
        } else if (ev.type === "draw-start") {
          downAt.current = { x: ev.x, y: ev.y };
          const p = toPage(ev.x, ev.y);
          if (isFreehandTool(t)) {
            penPts.current = [p];
            setPen([p]);
          } else if (isTwoPointTool(t)) {
            dragStart.current = p;
            setDrag({ a: p, b: p });
          }
        } else if (ev.type === "draw-move") {
          const p = toPage(ev.x, ev.y);
          if (isFreehandTool(t)) {
            penPts.current.push(p);
            setPen([...penPts.current]);
          } else if (isTwoPointTool(t) && dragStart.current) {
            setDrag({ a: dragStart.current, b: p });
          }
        } else if (ev.type === "draw-end") {
          const p = toPage(ev.x, ev.y);
          const down = downAt.current;
          const moved = down ? Math.hypot(ev.x - down.x, ev.y - down.y) : 0;
          downAt.current = null;
          if (isFreehandTool(t)) {
            penPts.current.push(p);
            const pts = penPts.current;
            penPts.current = [];
            setPen(null);
            // a tap with the pen leaves a dot (a one-point stroke is drawn as a round dot)
            commitInk({ kind: t, color: c, strokeWidth: strokeFor(t, pr), shape: strokeToShape(pts.length === 1 ? [pts[0], { x: pts[0].x + 0.01, y: pts[0].y }] : pts, v.zoom, pg) });
          } else if (isTwoPointTool(t)) {
            const a = dragStart.current;
            dragStart.current = null;
            setDrag(null);
            const shape = a ? twoPointShape(a, p, v.zoom, pg) : null;
            if (shape) commitInk({ kind: t, color: c, strokeWidth: strokeFor(t, pr), shape });
          } else if (t === "text" && moved < TAP_SLOP) {
            setTextAt({ at: p, value: "" });
          }
        }
      }
    },
    [commitInk],
  );

  // Pointer routing (native listeners: the stage needs non-passive wheel and pointer capture).
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const g = gesture.current;
    const local = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const down = (e: PointerEvent) => {
      if (isPalmContact(e) || (e.pointerType === "mouse" && e.button !== 0)) return;
      if ((e.target as HTMLElement).closest("[data-nogesture]")) return;
      if (!R.current.view) return;
      el.setPointerCapture(e.pointerId);
      const p = local(e);
      applyEvents(g.down(e.pointerId, p.x, p.y));
    };
    const move = (e: PointerEvent) => {
      const p = local(e);
      const co = e.getCoalescedEvents?.() ?? [];
      const list = co.length > 1 && g.drawing ? co.map((c) => ({ x: c.clientX - el.getBoundingClientRect().left, y: c.clientY - el.getBoundingClientRect().top })) : [p];
      for (const q of list) applyEvents(g.move(e.pointerId, q.x, q.y));
    };
    const up = (e: PointerEvent) => applyEvents(g.up(e.pointerId, e.type === "pointercancel"));
    const wheel = (e: WheelEvent) => {
      const lim = R.current.limits;
      if (!lim) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      applyEvents([{ type: "nav", dx: 0, dy: 0, scale: Math.exp(-e.deltaY * 0.0015), cx: e.clientX - r.left, cy: e.clientY - r.top }]);
    };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("wheel", wheel, { passive: false });
    return () => {
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      el.removeEventListener("wheel", wheel);
      g.reset();
    };
  }, [applyEvents]);

  const pickTool = (t: EditorTool) => {
    setTool(t);
    setStyleOpen(false);
    penPts.current = [];
    dragStart.current = null;
    setPen(null);
    setDrag(null);
  };

  const fit = () => {
    if (!page || size.width < 10) return;
    fittedRef.current = true;
    setView(fitView(page, size, 0, MARGIN));
  };

  const accept = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const flat = await flattenInk(image, history.items);
      await onAccept(flat);
    } catch (e) {
      setError(`Could not save the markup: ${(e as Error).message}`);
      setBusy(false);
    }
  };

  const cancel = () => (history.count > 0 ? setConfirmDiscard(true) : onCancel());

  // Hardware Back: close the text sheet, then the discard question, then ask to leave (never silently drop the drawing).
  const backRef = useRef(() => {});
  backRef.current = () => {
    if (busy) return;
    if (textAt) setTextAt(null);
    else if (confirmDiscard) setConfirmDiscard(false);
    else if (styleOpen) setStyleOpen(false);
    else cancel();
  };
  useEffect(
    () =>
      setBackGuard(() => {
        backRef.current();
        return true;
      }),
    [],
  );

  const submitText = () => {
    const s = textAt;
    if (!s) return;
    setTextAt(null);
    const text = s.value.trim().slice(0, MAX_TEXT);
    if (!text || !page) return;
    commitInk({ kind: "text", color: colour, strokeWidth: preset.stroke, shape: textShape({ x: clamp01(s.at.x / page.width) * page.width, y: clamp01(s.at.y / page.height) * page.height }, text, preset.text, page) });
  };

  // ── drawing ──────────────────────────────────────────────────────────
  const W = page?.width ?? 1;
  const inkProps = (kind: Ink["kind"], colourHex: string, strokeWidth: number) => ({
    fill: "none",
    stroke: colourHex,
    strokeWidth: Math.max(1.5, strokeWidth * W),
    strokeLinecap: (kind === "highlight" ? "butt" : "round") as "butt" | "round",
    strokeLinejoin: "round" as const,
    ...(kind === "highlight" ? { strokeOpacity: HIGHLIGHT_OPACITY, style: { mixBlendMode: "multiply" as const } } : {}),
  });
  const renderText = (ink: Ink) => {
    if (!page) return null;
    const box = textBox(ink.shape, page);
    const px = (ink.shape.size ?? 0.03) * page.width;
    return (
      <text key={ink.id} x={box.x} y={box.y} fontSize={px} fontWeight={600} fill={ink.color} stroke="#ffffff" strokeWidth={px / 6} paintOrder="stroke" dominantBaseline="hanging" style={{ fontFamily: "sans-serif" }}>
        {(ink.shape.text ?? "").split("\n").map((line, i) => (
          <tspan key={i} x={box.x} y={box.y + i * px * TEXT_LINE_HEIGHT}>
            {line || " "}
          </tspan>
        ))}
      </text>
    );
  };
  const draftD = (() => {
    if (!page || !view) return null;
    if (pen && pen.length > 1 && isFreehandTool(tool)) return smoothPath(pen);
    if (pen && pen.length === 1 && isFreehandTool(tool)) return `M${pen[0].x},${pen[0].y}l0.01,0`;
    if (drag && isTwoPointTool(tool) && Math.hypot(drag.b.x - drag.a.x, drag.b.y - drag.a.y) * view.zoom > 3) {
      const s = twoPointShape(drag.a, drag.b, 1e6, page);
      return s ? markupPath(tool, s, strokeFor(tool, preset), page) : null;
    }
    return null;
  })();

  const hint = tool === "text" ? "Tap where the label goes." : tool === "pen" || tool === "highlight" ? "Draw with one finger. Two fingers pan and zoom." : "Drag to draw the shape. Two fingers pan and zoom.";
  const matrix = view ? `translate(${view.tx}px, ${view.ty}px) scale(${view.zoom})` : undefined;

  return (
    <div className="mk-editor" data-testid="mk-editor" data-tool={tool} data-colour={colour} data-width={presetId} data-busy={busy ? "1" : "0"}>
      <div className="mk-top">
        <button type="button" className="mk-btn mk-text-btn" data-testid="mk-cancel" onClick={cancel} disabled={busy}>
          Cancel
        </button>
        <div className="mk-title">{title}</div>
        <div className="mk-history">
          <button type="button" className="mk-btn mk-icon-btn" data-testid="mk-undo" aria-label="Undo" disabled={!history.canUndo || busy} onClick={() => history.undo()}>
            <IconUndo />
          </button>
          <button type="button" className="mk-btn mk-icon-btn" data-testid="mk-redo" aria-label="Redo" disabled={!history.canRedo || busy} onClick={() => history.redo()}>
            <IconRedo />
          </button>
        </div>
        <button type="button" className="mk-btn mk-accept" data-testid="mk-accept" onClick={() => void accept()} disabled={busy || !page}>
          {busy ? "Saving..." : "Accept"}
        </button>
      </div>

      <div className="mk-body">
        <div className="mk-tools" role="toolbar" aria-label="Markup tools" data-testid="mk-tools">
          {TOOLS.map((t) => (
            <button key={t.id} type="button" className={`mk-tool${tool === t.id ? " is-on" : ""}`} data-testid={`mk-tool-${t.id}`} aria-pressed={tool === t.id} aria-label={t.label} onClick={() => pickTool(t.id)} disabled={busy}>
              {t.icon}
              <span className="mk-tool-label">{t.label}</span>
            </button>
          ))}
          <button type="button" className={`mk-tool mk-style-btn${styleOpen ? " is-on" : ""}`} data-testid="mk-style" aria-expanded={styleOpen} aria-label="Colour and width" onClick={() => setStyleOpen((o) => !o)} disabled={busy}>
            <span className="mk-dot" style={{ ["--sw" as string]: colour }} />
            <span className="mk-tool-label">Style</span>
          </button>
        </div>

        <div className="mk-stage" ref={stageRef} data-testid="mk-stage" data-zoom={view ? view.zoom.toFixed(4) : ""} data-fit={limits ? limits.fit.toFixed(4) : ""} data-tx={view ? Math.round(view.tx) : ""} data-ty={view ? Math.round(view.ty) : ""}>
          {url && (
            <div className="mk-content" style={{ width: page?.width, height: page?.height, transform: matrix, visibility: view ? "visible" : "hidden" }}>
              <img
                className="mk-img"
                data-testid="mk-image"
                src={url}
                alt="Captured view to mark up"
                draggable={false}
                onLoad={(e) => setPage({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })}
              />
              {page && (
                <svg className="mk-ink" viewBox={`0 0 ${page.width} ${page.height}`} width={page.width} height={page.height} data-testid="mk-ink" data-count={history.count} aria-hidden="true">
                  {history.items.map((ink) => {
                    if (ink.kind === "text") return <g key={ink.id} data-testid="mk-ink-item" data-kind="text">{renderText(ink)}</g>;
                    const d = markupPath(ink.kind, ink.shape, ink.strokeWidth, page);
                    return d ? (
                      <g key={ink.id} data-testid="mk-ink-item" data-kind={ink.kind}>
                        <path d={d} {...inkProps(ink.kind, ink.color, ink.strokeWidth)} />
                      </g>
                    ) : null;
                  })}
                  {draftD && <path data-testid="mk-draft" d={draftD} {...inkProps(tool, colour, strokeFor(tool, preset))} opacity={0.85} />}
                </svg>
              )}
            </div>
          )}
          {!url && <p className="mk-loading muted">Loading picture...</p>}
          {zoomed && (
            <button type="button" className="mk-btn mk-fit" data-testid="mk-fit" data-nogesture onClick={fit}>
              Fit
            </button>
          )}
          {!hintGone && page && (
            <p className="mk-hint" data-testid="mk-hint" role="status">
              {hint}
            </p>
          )}
          {error && (
            <p className="mk-error" role="alert" data-testid="mk-error" data-nogesture>
              {error}
            </p>
          )}
          {styleOpen && (
            <div className="mk-style-pop" data-nogesture data-testid="mk-style-pop" role="dialog" aria-label="Colour and width">
              <div className="mk-swatches" role="group" aria-label="Colour">
                {MARKUP_COLOURS.map((c) => (
                  <button key={c.id} type="button" className={`mk-swatch${colour === c.hex ? " is-on" : ""}`} data-testid={`mk-colour-${c.id}`} aria-label={c.label} aria-pressed={colour === c.hex} style={{ ["--sw" as string]: c.hex }} onClick={() => setColour(c.hex)} />
                ))}
              </div>
              <div className="mk-widths" role="group" aria-label="Width">
                {INK_PRESETS.map((p) => (
                  <button key={p.id} type="button" className={`mk-width${presetId === p.id ? " is-on" : ""}`} data-testid={`mk-width-${p.id}`} aria-label={p.label} aria-pressed={presetId === p.id} onClick={() => setPresetId(p.id)}>
                    <span className="mk-width-bar" style={{ height: `${Math.round(2 + p.stroke * 700)}px` }} />
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {textAt && (
        <div className="mk-scrim" onClick={() => setTextAt(null)}>
          <div className="mk-text-sheet" data-testid="mk-text-sheet" role="dialog" aria-label="Text label" onClick={(e) => e.stopPropagation()}>
            <h2>Text label</h2>
            <textarea className="mk-text-input" data-testid="mk-text-input" autoFocus rows={3} maxLength={MAX_TEXT} value={textAt.value} placeholder="What should be fixed here?" onChange={(e) => setTextAt({ ...textAt, value: e.target.value })} />
            <div className="mk-text-actions">
              <button type="button" className="mk-btn mk-text-btn" data-testid="mk-text-cancel" onClick={() => setTextAt(null)}>
                Cancel
              </button>
              <button type="button" className="mk-btn mk-accept" data-testid="mk-text-ok" disabled={!textAt.value.trim()} onClick={submitText}>
                Add
              </button>
            </div>
          </div>
        </div>
      )}
      {confirmDiscard && (
        <ConfirmDialog title="Discard this markup?" confirmLabel="Discard" danger onConfirm={onCancel} onCancel={() => setConfirmDiscard(false)} testId="mk-discard-dialog">
          Your drawing on this picture will be lost.
        </ConfirmDialog>
      )}
    </div>
  );
}
