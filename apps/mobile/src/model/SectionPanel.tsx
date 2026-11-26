import { AXES, axisIndex, axisLabel, metres, MIN_GAP, type Axis, type AxisPlane, type SectionState } from "./sectionBox";
import { MAX_SECTION_PLANES } from "@ff/viewer-react";
import type { Box } from "./viewMath";

interface Props {
  state: SectionState;
  bounds: Box | null;
  hasSelection: boolean;
  onBoxView: () => void;
  onBoxSelection: () => void;
  onBoxOff: () => void;
  onEdge: (axis: Axis, edge: "min" | "max", value: number) => void;
  onAddPlane: (axis: Axis) => void;
  onPlane: (index: number, patch: Partial<AxisPlane>) => void;
  onRemovePlane: (index: number) => void;
  onReset: () => void;
  onClose: () => void;
}

/**
 * Section box and planes. The box is edited with one pair of sliders per axis (precise, one finger, no accidental drags on the
 * model); planes cut along one axis and can be flipped or removed. Both clip only (no geometry is added) and combine with the
 * storey Cut.
 */
export function SectionPanel({ state, bounds, hasSelection, onBoxView, onBoxSelection, onBoxOff, onEdge, onAddPlane, onPlane, onRemovePlane, onReset, onClose }: Props) {
  const room = MAX_SECTION_PLANES - (state.box ? 6 : 0) - state.planes.length;
  return (
    <aside className="model-sheet tool-panel" data-testid="section-panel" aria-label="Section" data-box={state.box ? "on" : "off"} data-planes={state.planes.length}>
      <header className="model-sheet-head">
        <strong className="grow">Section</strong>
        <button type="button" className="btn small" data-testid="section-reset" disabled={!state.box && state.planes.length === 0} onClick={onReset}>
          Reset
        </button>
        <button type="button" className="btn small" data-testid="section-close" aria-label="Close section tools" onClick={onClose}>
          ✕
        </button>
      </header>
      <div className="model-sheet-body">
        <h4>Section box</h4>
        <div className="tool-row">
          <button type="button" className="btn small" data-testid="section-box-view" disabled={!bounds} onClick={onBoxView}>
            Box around view
          </button>
          <button type="button" className="btn small" data-testid="section-box-selection" disabled={!bounds || !hasSelection} onClick={onBoxSelection}>
            Box around selection
          </button>
          {state.box && (
            <button type="button" className="btn small" data-testid="section-box-off" onClick={onBoxOff}>
              Remove box
            </button>
          )}
        </div>
        {!state.box && <p className="muted small-text">Cuts the model to a box. Drag the sliders to move each face; everything outside the box is clipped.</p>}
        {state.box && bounds && (
          <div className="axis-list" data-testid="section-box-controls">
            {AXES.map((a) => {
              const i = axisIndex(a);
              const lo = bounds.min[i];
              const hi = bounds.max[i];
              return (
                <div key={a} className="axis-group" data-axis={a}>
                  <div className="axis-title">{axisLabel(a)}</div>
                  <label className="slider-row">
                    <span>{a === "y" ? "Bottom" : "From"}</span>
                    <input type="range" data-testid={`section-${a}-min`} min={lo} max={hi} step={0.05} value={state.box!.min[i]} onChange={(e) => onEdge(a, "min", Number(e.target.value))} />
                    <output>{metres(state.box!.min[i])}</output>
                  </label>
                  <label className="slider-row">
                    <span>{a === "y" ? "Top" : "To"}</span>
                    <input type="range" data-testid={`section-${a}-max`} min={lo} max={hi} step={0.05} value={state.box!.max[i]} onChange={(e) => onEdge(a, "max", Number(e.target.value))} />
                    <output>{metres(state.box!.max[i])}</output>
                  </label>
                </div>
              );
            })}
            <p className="muted small-text">Faces stay at least {MIN_GAP * 100} cm apart.</p>
          </div>
        )}

        <h4>Section planes</h4>
        <div className="tool-row">
          {AXES.map((a) => (
            <button key={a} type="button" className="btn small" data-testid={`section-add-${a}`} disabled={!bounds || room <= 0} onClick={() => onAddPlane(a)}>
              + {a === "y" ? "Height" : a.toUpperCase()}
            </button>
          ))}
        </div>
        {room <= 0 && <p className="muted small-text">At most {MAX_SECTION_PLANES} planes in all (the box uses 6).</p>}
        <ul className="plane-list">
          {state.planes.map((p, k) => {
            const i = axisIndex(p.axis);
            return (
              <li key={k} data-testid="section-plane" data-axis={p.axis} data-flipped={p.flipped}>
                <div className="axis-title">
                  {axisLabel(p.axis)} <span className="muted">{p.flipped ? "keeps above" : "keeps below"}</span>
                </div>
                <label className="slider-row">
                  <input type="range" data-testid="section-plane-offset" min={bounds?.min[i] ?? 0} max={bounds?.max[i] ?? 1} step={0.05} value={p.offset} onChange={(e) => onPlane(k, { offset: Number(e.target.value) })} />
                  <output>{metres(p.offset)}</output>
                </label>
                <div className="tool-row">
                  <button type="button" className="btn small" data-testid="section-plane-flip" onClick={() => onPlane(k, { flipped: !p.flipped })}>
                    Flip
                  </button>
                  <button type="button" className="btn small" data-testid="section-plane-remove" onClick={() => onRemovePlane(k)}>
                    Remove
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
        <p className="muted small-text">Sections combine with the storey Cut.</p>
      </div>
    </aside>
  );
}
