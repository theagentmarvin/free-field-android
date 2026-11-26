import { useCallback, useEffect, useRef, useState } from "react";
import { drawShapes, type Ctx2D } from "./render";
import {
  COLORS,
  MIN_DRAG,
  STROKE,
  TEXT_SIZE,
  canRedo,
  canUndo,
  clampPt,
  clearAll,
  commit,
  dragLength,
  emptyHistory,
  redo,
  undo,
  type History,
  type Pt,
  type Shape,
  type Tool,
} from "./model";

const TOOLS: { id: Tool; label: string }[] = [
  { id: "pen", label: "Pen" },
  { id: "arrow", label: "Arrow" },
  { id: "rect", label: "Box" },
  { id: "text", label: "Text" },
];

/**
 * Full-screen annotation editor over the ORIGINAL photo. It only produces
 * shapes (normalized coordinates); flattening to JPEG happens in the caller
 * via `applyAnnotations`, so the original stays untouched.
 */
export function AnnotationEditor({
  original,
  initialShapes,
  onDone,
  onCancel,
}: {
  original: Blob;
  initialShapes: Shape[];
  onDone(shapes: Shape[]): void;
  onCancel(): void;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [hist, setHist] = useState<History>({ ...emptyHistory, shapes: initialShapes });
  const [tool, setTool] = useState<Tool>("pen");
  const [color, setColor] = useState<string>(COLORS[0]);
  const [draft, setDraft] = useState<Shape | null>(null);
  const [textAt, setTextAt] = useState<Pt | null>(null);
  const [textValue, setTextValue] = useState("");
  const imgRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const idSeq = useRef(0);
  const nextId = () => `s${Date.now().toString(36)}${idSeq.current++}`;

  useEffect(() => {
    const url = URL.createObjectURL(original);
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [original]);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img || !img.clientWidth) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(img.clientWidth * dpr);
    const h = Math.round(img.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    drawShapes(ctx as unknown as Ctx2D, draft ? [...hist.shapes, draft] : hist.shapes, w, h);
  }, [hist.shapes, draft]);

  useEffect(redraw, [redraw, src]);
  useEffect(() => {
    window.addEventListener("resize", redraw);
    return () => window.removeEventListener("resize", redraw);
  }, [redraw]);

  const toNorm = (e: React.PointerEvent): Pt => {
    const r = canvasRef.current!.getBoundingClientRect();
    return clampPt([(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height]);
  };

  const onDown = (e: React.PointerEvent) => {
    if (textAt) return;
    const p = toNorm(e);
    (e.target as Element).setPointerCapture?.(e.pointerId);
    if (tool === "text") {
      setTextAt(p);
      setTextValue("");
      return;
    }
    if (tool === "pen") setDraft({ id: nextId(), kind: "pen", color, width: STROKE.medium, points: [p] });
    else setDraft({ id: nextId(), kind: tool, color, width: STROKE.medium, from: p, to: p });
  };
  const onMove = (e: React.PointerEvent) => {
    if (!draft) return;
    const p = toNorm(e);
    setDraft(draft.kind === "pen" ? { ...draft, points: [...draft.points, p] } : draft.kind === "text" ? draft : { ...draft, to: p });
  };
  const onUp = () => {
    if (!draft) return;
    const keep =
      draft.kind === "pen"
        ? true
        : draft.kind === "text"
          ? false
          : dragLength(draft.from, draft.to) >= MIN_DRAG;
    if (keep) setHist((h) => commit(h, draft));
    setDraft(null);
  };

  const addText = () => {
    const text = textValue.trim();
    if (text && textAt) setHist((h) => commit(h, { id: nextId(), kind: "text", color, size: TEXT_SIZE, at: textAt, text }));
    setTextAt(null);
    setTextValue("");
  };

  return (
    <div className="annot" data-testid="annotation-editor" role="dialog" aria-label="Annotate photo">
      <div className="annot-bar">
        <button type="button" className="btn" data-testid="annot-cancel" onClick={onCancel}>
          Cancel
        </button>
        <div className="annot-tools" role="group" aria-label="Tools">
          {TOOLS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`chip${tool === t.id ? " is-on" : ""}`}
              data-testid={`tool-${t.id}`}
              aria-pressed={tool === t.id}
              onClick={() => setTool(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <button type="button" className="btn primary" data-testid="annot-done" onClick={() => onDone([...hist.shapes])}>
          Done
        </button>
      </div>
      <div className="annot-stage">
        <div className="annot-frame">
          {src && <img ref={imgRef} src={src} alt="Photo to annotate" onLoad={redraw} draggable={false} />}
          <canvas
            ref={canvasRef}
            data-testid="annot-canvas"
            data-shapes={hist.shapes.length}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
          />
          {textAt && (
            <div className="annot-text" style={{ left: `${textAt[0] * 100}%`, top: `${textAt[1] * 100}%` }}>
              <input
                autoFocus
                className="input"
                data-testid="annot-text-input"
                value={textValue}
                placeholder="Label"
                onChange={(e) => setTextValue(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addText()}
              />
              <button type="button" className="btn primary" data-testid="annot-text-add" onClick={addText}>
                Add
              </button>
            </div>
          )}
        </div>
      </div>
      <div className="annot-bar">
        <div className="swatches" role="group" aria-label="Color">
          {COLORS.map((c) => (
            <button
              key={c}
              type="button"
              className={`swatch${color === c ? " is-on" : ""}`}
              style={{ background: c }}
              aria-label={`Color ${c}`}
              aria-pressed={color === c}
              data-testid={`color-${c.slice(1)}`}
              onClick={() => setColor(c)}
            />
          ))}
        </div>
        <div className="annot-tools">
          <button type="button" className="btn" data-testid="annot-undo" disabled={!canUndo(hist)} onClick={() => setHist(undo)}>
            Undo
          </button>
          <button type="button" className="btn" data-testid="annot-redo" disabled={!canRedo(hist)} onClick={() => setHist(redo)}>
            Redo
          </button>
          <button type="button" className="btn" data-testid="annot-clear" disabled={hist.shapes.length === 0} onClick={() => setHist(clearAll)}>
            Clear
          </button>
        </div>
      </div>
    </div>
  );
}
