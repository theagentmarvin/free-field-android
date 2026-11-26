import { useEffect, useMemo, useRef, useState } from "react";
import { flattenRows, PAGE, rowNameIds, type Row, type TNode } from "./tree";
import { groupVisibility, type Hidden } from "./visibility";

interface Props {
  roots: readonly TNode[] | null;
  loading: boolean;
  error: string | null;
  hidden: (modelId: string) => Hidden | undefined;
  /** bump to re-render when visibility changed */
  visRev: number;
  names: (modelId: string, ids: readonly number[]) => Promise<Map<number, string>>;
  selectedKey: string | null;
  selectedTitle: string | null;
  onSelect: (node: TNode) => void;
  onToggle: (node: TNode, visible: boolean) => void;
  onIsolate: (node: TNode) => void;
  onProperties: () => void;
  onClose: () => void;
}

const nameKey = (modelId: string, id: number) => `${modelId}:${id}`;

/** Model tree sheet: lazy expansion, 100 rows per group at a time, names read for the visible rows only. */
export function TreePanel({ roots, loading, error, hidden, visRev, names, selectedKey, selectedTitle, onSelect, onToggle, onIsolate, onProperties, onClose }: Props) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [shown, setShown] = useState<ReadonlyMap<string, number>>(new Map());
  const [labels, setLabels] = useState<ReadonlyMap<string, string>>(new Map());
  const asked = useRef(new Set<string>());

  // Models start open (their first level is the building).
  useEffect(() => {
    if (roots && roots.length) setExpanded((cur) => (cur.size ? cur : new Set(roots.map((r) => r.key))));
  }, [roots]);

  const rows = useMemo<Row[]>(() => (roots ? flattenRows(roots, expanded, shown) : []), [roots, expanded, shown]);

  // Read the names of the rows on screen that have none yet (one worker request per model).
  useEffect(() => {
    let live = true;
    for (const [modelId, ids] of rowNameIds(rows)) {
      const todo = ids.filter((id) => !asked.current.has(nameKey(modelId, id)));
      if (!todo.length) continue;
      for (const id of todo) asked.current.add(nameKey(modelId, id));
      void names(modelId, todo).then((got) => {
        if (!live || got.size === 0) return;
        setLabels((cur) => {
          const next = new Map(cur);
          for (const [id, n] of got) next.set(nameKey(modelId, id), n);
          return next;
        });
      });
    }
    return () => {
      live = false;
    };
  }, [rows, names]);

  const toggleOpen = (n: TNode) =>
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(n.key)) next.delete(n.key);
      else next.add(n.key);
      return next;
    });

  return (
    <aside className="model-sheet tool-panel" data-testid="tree-panel" aria-label="Model tree">
      <header className="model-sheet-head">
        <strong className="grow">Model tree</strong>
        <button type="button" className="btn small" data-testid="tree-close" aria-label="Close model tree" onClick={onClose}>
          ✕
        </button>
      </header>
      {selectedTitle && (
        <div className="tool-selected" data-testid="tree-selected">
          <span className="grow">{selectedTitle}</span>
          <button type="button" className="btn small" data-testid="tree-properties" onClick={onProperties}>
            Properties
          </button>
        </div>
      )}
      <div className="model-sheet-body tree-body" data-testid="tree-rows" data-rev={visRev}>
        {loading && <p className="muted">Reading the models' structure…</p>}
        {error && <p className="error">{error}</p>}
        {!loading && !error && roots?.length === 0 && <p className="muted">No models loaded.</p>}
        {rows.map((r) => {
          if (r.type === "more") {
            return (
              <button key={`more-${r.parentKey}`} type="button" className="tree-more" data-testid="tree-more" style={{ paddingLeft: 12 + r.depth * 18 }} onClick={() => setShown((cur) => new Map(cur).set(r.parentKey, (cur.get(r.parentKey) ?? PAGE) + PAGE))}>
                Show {Math.min(PAGE, r.remaining)} more ({r.remaining.toLocaleString()} left)
              </button>
            );
          }
          const n = r.node;
          const label = (n.localId !== null ? labels.get(nameKey(n.modelId, n.localId)) : null) ?? n.fallback;
          const h = hidden(n.modelId);
          const vis = h ? groupVisibility(h, n.kind === "element" ? [n.localId as number] : n.ids()) : "all";
          const isElement = n.kind === "element";
          return (
            <div key={n.key} className={`tree-row${n.localId !== null && selectedKey === nameKey(n.modelId, n.localId) ? " is-selected" : ""}`} data-testid="tree-row" data-kind={n.kind} data-key={n.key} data-local-id={n.localId ?? ""} data-visible={vis} style={{ paddingLeft: 4 + r.depth * 18 }}>
              {n.children ? (
                <button type="button" className="tree-chevron" data-testid="tree-toggle" aria-label={r.expanded ? "Collapse" : "Expand"} aria-expanded={r.expanded} onClick={() => toggleOpen(n)}>
                  {r.expanded ? "▾" : "▸"}
                </button>
              ) : (
                <span className="tree-chevron" aria-hidden="true" />
              )}
              <button type="button" className="tree-label" data-testid="tree-label" onClick={() => (!isElement && n.children ? toggleOpen(n) : onSelect(n))}>
                <span className="tree-title">{label}</span>
                {!isElement && <span className="muted small-text">{n.count.toLocaleString()}</span>}
              </button>
              {!isElement && n.count > 0 && (
                <button type="button" className="tree-act" data-testid="tree-isolate" aria-label={`Isolate ${label}`} onClick={() => onIsolate(n)}>
                  Isolate
                </button>
              )}
              <label className="tree-check">
                <input
                  type="checkbox"
                  data-testid="tree-check"
                  aria-label={`${label} visible`}
                  checked={vis === "all"}
                  ref={(el) => {
                    if (el) el.indeterminate = vis === "some";
                  }}
                  onChange={() => onToggle(n, vis === "none")}
                />
              </label>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
