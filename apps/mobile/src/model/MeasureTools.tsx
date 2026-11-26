import type { MeasurementEntry, MeasureVariant } from "@ff/viewer-react";
import { canFinish3d, hintFor, VARIANTS } from "./measureState";

export const GESTURE_HINT = "Tap to place on the plane · hold to aim precisely · drag to rotate";
export const VOLUME_HINT = "Tap an element to measure its volume · drag to rotate";
export const PLANE_HINT = "First tap the surface to measure on (a floor, a wall, a face) · drag to rotate";

interface BarProps {
  variant: MeasureVariant;
  placed: number;
  /** This variant draws on a measuring plane (all but volume), and whether one is set yet. */
  needsPlane: boolean;
  planeSet: boolean;
  onChangePlane: () => void;
  /** Live value of the measurement being drawn ("3.42 m"), or "". */
  live: string;
  notice: string | null;
  count: number;
  onVariant: (v: MeasureVariant) => void;
  onUndo: () => void;
  onFinish: () => void;
  onCancel: () => void;
  onDone: () => void;
  onList: () => void;
}

/** Bottom bar while measuring in 3D: mode chips, Undo / Finish / Cancel / Done and the list. */
export function MeasureBar({ variant, placed, needsPlane, planeSet, onChangePlane, live, notice, count, onVariant, onUndo, onFinish, onCancel, onDone, onList }: BarProps) {
  const choosing = needsPlane && !planeSet;
  return (
    <div className="model-measure-bar" data-testid="measure3d-bar" data-variant={variant} data-placed={placed} data-plane={needsPlane ? (planeSet ? "1" : "0") : ""} role="toolbar" aria-label="Measure tools">
      <p className="pm-hint-line" data-testid="measure3d-hint">{!needsPlane ? VOLUME_HINT : choosing ? PLANE_HINT : GESTURE_HINT}</p>
      <div className="pm-row pm-tools">
        {VARIANTS.map((v) => (
          <button key={v.id} type="button" className={`chip${variant === v.id ? " is-on" : ""}`} data-testid={`measure3d-${v.id}`} aria-pressed={variant === v.id} onClick={() => onVariant(v.id)}>
            {v.label}
          </button>
        ))}
      </div>
      <div className="pm-row">
        <span className="pm-live" data-testid="measure3d-live" aria-live="polite">
          {notice ?? (choosing ? "Step 1: pick the plane" : live ? live : hintFor(variant, placed))}
        </span>
        {needsPlane && planeSet && (
          <button type="button" className="btn small" data-testid="measure3d-plane" onClick={onChangePlane}>
            Change plane
          </button>
        )}
        <button type="button" className="btn small" data-testid="measure3d-undo" disabled={placed === 0} onClick={onUndo}>
          Undo point
        </button>
        {(variant === "area" || variant === "volume") && (
          <button type="button" className="btn small primary" data-testid="measure3d-finish" disabled={!canFinish3d(variant, placed)} onClick={onFinish}>
            Finish
          </button>
        )}
        <button type="button" className="btn small" data-testid="measure3d-cancel" disabled={placed === 0} onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="btn small" data-testid="measure3d-list" onClick={onList}>
          List ({count})
        </button>
        <button type="button" className="btn small" data-testid="measure3d-done" onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  );
}

interface SheetProps {
  entries: readonly MeasurementEntry[];
  onFocus: (id: string) => void;
  onDelete: (id: string) => void;
  onClear: () => void;
  onClose: () => void;
}

/** The measurements on the model: focus (frame in the camera), delete one, clear all. */
export function MeasureSheet({ entries, onFocus, onDelete, onClear, onClose }: SheetProps) {
  return (
    <aside className="model-sheet" data-testid="measure3d-sheet" aria-label="Measurements">
      <header className="model-sheet-head">
        <strong className="grow">Measurements</strong>
        <button type="button" className="btn small" data-testid="measure3d-sheet-close" aria-label="Close measurements" onClick={onClose}>
          ✕
        </button>
      </header>
      <div className="model-sheet-body">
        {entries.length === 0 && <p className="muted">No measurements on this model yet.</p>}
        <ul className="pm-list">
          {entries.map((e) => (
            <li key={e.id} data-testid="measure3d-row" data-variant={e.variant} data-value={e.value ?? ""} data-unit={e.unit} data-text={e.text}>
              <button type="button" className="pm-row-main" data-testid="measure3d-row-focus" onClick={() => onFocus(e.id)}>
                <span className="pm-swatch" style={{ background: `var(--m-${e.variant})` }} />
                <span className="grow">{e.label}</span>
                <strong>{e.text}</strong>
              </button>
              <button type="button" className="btn small" data-testid="measure3d-row-delete" aria-label={`Delete ${e.label}`} onClick={() => onDelete(e.id)}>
                ✕
              </button>
            </li>
          ))}
        </ul>
        {entries.length > 0 && (
          <button type="button" className="btn danger" data-testid="measure3d-clear" onClick={onClear}>
            Clear all
          </button>
        )}
      </div>
    </aside>
  );
}
