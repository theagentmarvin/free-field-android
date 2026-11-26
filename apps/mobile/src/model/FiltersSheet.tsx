import { categoryLabel } from "./tree";

export interface CategoryRow {
  name: string;
  count: number;
}

export interface FilterModel {
  modelId: string;
  label: string;
  visible: boolean;
  /** CSS colour of the dot (never the only cue: the row has a check mark) */
  color: string;
}

interface Props {
  levels: readonly string[];
  level: string | null;
  cut: boolean;
  models: readonly FilterModel[];
  categories: readonly CategoryRow[] | null;
  hiddenCategories: ReadonlySet<string>;
  hasSelection: boolean;
  isolated: boolean;
  xray: boolean;
  disabled: boolean;
  onLevel: (name: string | null) => void;
  onCut: (on: boolean) => void;
  onModel: (modelId: string, visible: boolean) => void;
  onAllModels: (visible: boolean) => void;
  onCategory: (name: string, visible: boolean) => void;
  onAllCategories: (visible: boolean) => void;
  onIsolate: () => void;
  onHide: () => void;
  onXray: () => void;
  onReset: () => void;
  onDone: () => void;
}

/**
 * One sheet for every filter: Level (single choice, with Cut as a toggle of the level), Models (multi choice, visibility only: a
 * hidden model stays loaded), Categories and the selection actions. Native radios and checkboxes (a check mark as well as colour),
 * 44 px rows, Reset and Done in the footer.
 */
export function FiltersSheet({ levels, level, cut, models, categories, hiddenCategories, hasSelection, isolated, xray, disabled, onLevel, onCut, onModel, onAllModels, onCategory, onAllCategories, onIsolate, onHide, onXray, onReset, onDone }: Props) {
  return (
    <aside className="model-sheet tool-panel filters-sheet" data-testid="filters-sheet" aria-label="Filters" role="dialog">
      <header className="model-sheet-head">
        <strong className="grow">Filters</strong>
        <button type="button" className="btn small" data-testid="filters-close" aria-label="Close filters" onClick={onDone}>
          ✕
        </button>
      </header>
      <div className="model-sheet-body filters-body">
        {levels.length > 0 && (
          <section aria-labelledby="flt-level">
            <h4 id="flt-level">Level</h4>
            <div className="filter-scroll" role="radiogroup" aria-labelledby="flt-level" data-testid="filter-levels">
              <label className="check-row" data-testid="filter-level-all" data-selected={level === null}>
                <input type="radio" name="flt-level" checked={level === null} disabled={disabled} onChange={() => onLevel(null)} />
                <span className="grow">All levels</span>
                {level === null && <span aria-hidden="true">✓</span>}
              </label>
              {levels.map((n) => (
                <label key={n} className="check-row" data-testid="filter-level" data-level={n} data-selected={level === n}>
                  <input type="radio" name="flt-level" checked={level === n} disabled={disabled} onChange={() => onLevel(n)} />
                  <span className="grow">{n}</span>
                  {level === n && <span aria-hidden="true">✓</span>}
                </label>
              ))}
            </div>
            <label className="check-row" data-testid="filter-cut" data-on={cut && level !== null}>
              <input type="checkbox" checked={cut && level !== null} disabled={disabled || level === null} onChange={(e) => onCut(e.target.checked)} />
              <span className="grow">Cut at this level</span>
              {level === null && <span className="muted small-text">pick a level</span>}
            </label>
          </section>
        )}

        {models.length > 0 && (
          <section aria-labelledby="flt-models">
            <div className="section-head">
              <h4 id="flt-models" className="grow">
                Models
              </h4>
              <button type="button" className="btn small" data-testid="filter-models-all" onClick={() => onAllModels(true)}>
                All
              </button>
              <button type="button" className="btn small" data-testid="filter-models-none" onClick={() => onAllModels(false)}>
                None
              </button>
            </div>
            <div className="filter-scroll" data-testid="filter-models">
              {models.map((m) => (
                <label key={m.modelId} className="check-row" data-testid="filter-model" data-model={m.modelId} data-label={m.label} data-visible={m.visible}>
                  <input type="checkbox" checked={m.visible} disabled={disabled} onChange={() => onModel(m.modelId, !m.visible)} />
                  <span className="color-dot" style={{ background: m.color }} aria-hidden="true" />
                  <span className="grow">{m.label}</span>
                  {m.visible && <span aria-hidden="true">✓</span>}
                </label>
              ))}
            </div>
            <p className="muted small-text">Hidden models stay loaded; this only changes what is drawn.</p>
          </section>
        )}

        <section aria-labelledby="flt-cats">
          <div className="section-head">
            <h4 id="flt-cats" className="grow">
              Categories
            </h4>
            <button type="button" className="btn small" data-testid="filter-categories-all" disabled={!categories?.length} onClick={() => onAllCategories(true)}>
              All
            </button>
            <button type="button" className="btn small" data-testid="filter-categories-none" disabled={!categories?.length} onClick={() => onAllCategories(false)}>
              None
            </button>
          </div>
          {categories === null && <p className="muted" data-testid="filter-categories-loading">Reading the models' categories…</p>}
          {categories?.length === 0 && <p className="muted">These models have no categories.</p>}
          <div className="filter-scroll" data-testid="filter-categories">
            {categories?.map((c) => {
              const on = !hiddenCategories.has(c.name);
              return (
                <label key={c.name} className="check-row" data-testid="filter-category" data-category={c.name} data-visible={on}>
                  <input type="checkbox" checked={on} onChange={() => onCategory(c.name, !on)} />
                  <span className="grow">{categoryLabel(c.name)}</span>
                  <span className="muted small-text">{c.count.toLocaleString()}</span>
                  {on && <span aria-hidden="true">✓</span>}
                </label>
              );
            })}
          </div>
        </section>

        <section aria-labelledby="flt-sel">
          <h4 id="flt-sel">Selection</h4>
          <div className="tool-row">
            <button type="button" className="btn small" data-testid="vis-isolate" aria-pressed={isolated} disabled={!hasSelection} onClick={onIsolate}>
              Isolate
            </button>
            <button type="button" className="btn small" data-testid="vis-hide" disabled={!hasSelection} onClick={onHide}>
              Hide
            </button>
            <button type="button" className="btn small" data-testid="vis-xray" aria-pressed={xray} disabled={!hasSelection && !xray} onClick={onXray}>
              X-ray others
            </button>
          </div>
          {!hasSelection && <p className="muted small-text">Tap an element to isolate, hide or x-ray around it.</p>}
        </section>
      </div>
      <footer className="filters-foot">
        <button type="button" className="btn" data-testid="filter-reset" onClick={onReset}>
          Reset
        </button>
        <button type="button" className="btn primary" data-testid="filter-done" onClick={onDone}>
          Done
        </button>
      </footer>
    </aside>
  );
}
