import { useEffect, useRef, useState } from "react";
import { categoryLabel } from "./tree";
import type { SearchResults, SearchRow } from "./searchEngine";

interface Props {
  results: SearchResults | null;
  busy: boolean;
  selectedKey: string | null;
  selectedTitle: string | null;
  onQuery: (q: string) => void;
  onPick: (row: SearchRow) => void;
  onIsolateCategory: (name: string) => void;
  onProperties: () => void;
  onClose: () => void;
}

const DEBOUNCE_MS = 300;

/** Search sheet: one field for names, types, GlobalIds and property values; results fly to and select the element. */
export function SearchPanel({ results, busy, selectedKey, selectedTitle, onQuery, onPick, onIsolateCategory, onProperties, onClose }: Props) {
  const [text, setText] = useState("");
  const timer = useRef<number | null>(null);
  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);
  const change = (v: string) => {
    setText(v);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => onQuery(v), DEBOUNCE_MS);
  };
  const submit = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    onQuery(text);
  };
  return (
    <aside className="model-sheet tool-panel" data-testid="search-panel" aria-label="Search elements">
      <header className="model-sheet-head">
        <input
          className="field grow"
          data-testid="search-input"
          type="search"
          inputMode="search"
          enterKeyHint="search"
          placeholder="Name, type, GlobalId or property value"
          value={text}
          autoFocus
          onChange={(e) => change(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
        <button type="button" className="btn small" data-testid="search-close" aria-label="Close search" onClick={onClose}>
          ✕
        </button>
      </header>
      {selectedTitle && (
        <div className="tool-selected" data-testid="search-selected">
          <span className="grow">{selectedTitle}</span>
          <button type="button" className="btn small" data-testid="search-properties" onClick={onProperties}>
            Properties
          </button>
        </div>
      )}
      <div className="model-sheet-body" data-testid="search-results" data-busy={busy} data-total={results?.total ?? ""}>
        {busy && <p className="muted">Searching…</p>}
        {!busy && results && results.rows.length === 0 && results.categories.length === 0 && <p className="muted" data-testid="search-empty">Nothing found for "{results.query.trim()}".</p>}
        {results && results.categories.length > 0 && (
          <div className="tool-row" data-testid="search-categories">
            {results.categories.map((c) => (
              <button key={c.name} type="button" className="chip" data-testid="search-category" data-category={c.name} onClick={() => onIsolateCategory(c.name)}>
                Isolate {categoryLabel(c.name).toLowerCase()} ({c.count.toLocaleString()})
              </button>
            ))}
          </div>
        )}
        {results && results.rows.length > 0 && (
          <p className="muted small-text" data-testid="search-count">
            {results.truncated ? `First ${results.rows.length} of ${results.total.toLocaleString()} elements` : `${results.total.toLocaleString()} element${results.total === 1 ? "" : "s"}`}
          </p>
        )}
        <ul className="pm-list">
          {results?.rows.map((r) => {
            const key = `${r.modelId}:${r.localId}`;
            return (
              <li key={key}>
                <button type="button" className={`pm-row-main${selectedKey === key ? " is-selected" : ""}`} data-testid="search-row" data-model={r.modelId} data-local-id={r.localId} data-kind={r.kind} onClick={() => onPick(r)}>
                  <span className="grow search-title">{r.title}</span>
                  <span className="muted small-text">{r.sub}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </aside>
  );
}
