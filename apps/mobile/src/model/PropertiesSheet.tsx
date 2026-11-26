import type { PropsState } from "./properties";

interface Props {
  state: PropsState;
  localId: number;
  point: boolean;
  onNewTask: () => void;
  onIsolate?: () => void;
  onHide?: () => void;
  onSectionBox?: () => void;
  onClose: () => void;
}

/** Bottom sheet (phone) / side panel (tablet) with the picked element's attributes and property sets. */
export function PropertiesSheet({ state, localId, point, onNewTask, onIsolate, onHide, onSectionBox, onClose }: Props) {
  const p = state.status === "ready" ? state.props : null;
  return (
    <aside className="model-sheet" data-testid="props-sheet" aria-label="Element properties">
      <header className="model-sheet-head">
        <div className="grow">
          <strong data-testid="props-title">{p?.title ?? `Element ${localId}`}</strong>
          <div className="muted small-text">
            {p?.category ?? (state.status === "loading" ? "Loading…" : "")}
            {p?.guid ? ` · ${p.guid}` : ""}
          </div>
        </div>
        <button type="button" className="btn small primary" data-testid="props-new-task" onClick={onNewTask}>
          New task here
        </button>
        <button type="button" className="btn small" data-testid="props-close" onClick={onClose} aria-label="Close properties">
          ✕
        </button>
      </header>
      {(onIsolate || onHide || onSectionBox) && (
        <div className="tool-row props-actions" data-testid="props-actions">
          {onIsolate && <button type="button" className="btn small" data-testid="props-isolate" onClick={onIsolate}>Isolate</button>}
          {onHide && <button type="button" className="btn small" data-testid="props-hide" onClick={onHide}>Hide</button>}
          {onSectionBox && <button type="button" className="btn small" data-testid="props-section-box" onClick={onSectionBox}>Section box</button>}
        </div>
      )}
      <div className="model-sheet-body">
        {state.status === "error" && (
          <p className="error" data-testid="props-error" data-reason={state.reason}>
            {state.reason === "timeout" ? "Reading this element's properties is taking too long. Close and tap it again." : "Could not read this element's properties."}
          </p>
        )}
        {p && (
          <>
            <h4>Attributes</h4>
            <dl className="kv" data-testid="props-attrs">
              {p.attributes.map(([k, v]) => (
                <div key={k} className="kv-row">
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
            {p.psets.map((g) => (
              <section key={g.name} data-testid="props-pset">
                <h4>{g.name}</h4>
                <dl className="kv">
                  {g.rows.map(([k, v]) => (
                    <div key={k} className="kv-row">
                      <dt>{k}</dt>
                      <dd>{v}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
            {!point && <p className="muted small-text">No surface point yet: the task will be pinned at the element's centre.</p>}
          </>
        )}
      </div>
    </aside>
  );
}
