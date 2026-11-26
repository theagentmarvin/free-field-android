import { useMemo, useState } from "react";
import {
  DATE_PRESETS,
  DATE_PRESET_LABELS,
  DEADLINE_PRESETS,
  DEADLINE_PRESET_LABELS,
  TABLE_COLUMNS,
  distinctOptions,
  emptyFilter,
  filterSelectionCount,
  isFilterEmpty,
  type ColumnFilter,
  type ColumnId,
  type DatePresetKey,
  type DeadlinePresetKey,
  type SavedView,
  type TableColumn,
  type TaskTableRow,
} from "@ff/tasks-react";
import { Sheet } from "./ui";
import { useListStore, type ListSort } from "./listStore";

/** Sort choices: the web's three keys plus the tablet's Title A-Z (which the web reaches through the Title header). */
export const SORT_CHOICES: readonly { id: ListSort; label: string }[] = [
  { id: "updated", label: "Updated" },
  { id: "deadline", label: "Deadline" },
  { id: "created", label: "Created" },
  { id: "title", label: "Title A-Z" },
];

/** The columns the web offers a filter for: every registry column that declares a `filterKind`. */
export const FILTER_COLUMNS: readonly TableColumn[] = TABLE_COLUMNS.filter((c) => c.filterKind);

/** Short text for a column filter's removable chip. */
export function describeFilter(col: TableColumn, f: ColumnFilter): string {
  switch (f.kind) {
    case "distinct":
      return `${col.label}: ${f.keys.join(", ")}`;
    case "contains":
      return `${col.label}: "${f.query.trim()}"`;
    case "deadline":
      return `${col.label}: ${f.presets.map((p) => DEADLINE_PRESET_LABELS[p]).join(", ")}`;
    case "date":
      return `${col.label}: ${f.presets.map((p) => DATE_PRESET_LABELS[p]).join(", ")}`;
    case "number": {
      const lo = f.min ?? "";
      const hi = f.max ?? "";
      return `${col.label}: ${lo === "" ? "up to " + hi : hi === "" ? "from " + lo : `${lo} to ${hi}`}`;
    }
  }
}

/** Active filters as removable chips under the search, with a clear-all control. */
export function ActiveFilterChips() {
  const { columnFilters, quick, setColumnFilter, setQuick, clearFilters } = useListStore();
  const items: { key: string; label: string; remove: () => void }[] = [];
  if (quick.mine) items.push({ key: "quick-mine", label: "Mine", remove: () => setQuick({ ...quick, mine: false }) });
  if (quick.overdue) items.push({ key: "quick-overdue", label: "Overdue", remove: () => setQuick({ ...quick, overdue: false }) });
  for (const col of FILTER_COLUMNS) {
    const f = columnFilters[col.id];
    if (f && !isFilterEmpty(f)) items.push({ key: col.id, label: describeFilter(col, f), remove: () => setColumnFilter(col.id, undefined) });
  }
  if (items.length === 0) return null;
  return (
    <div className="active-filters" data-testid="active-filters">
      {items.map((it) => (
        <span key={it.key} className="filter-chip" data-testid={`active-${it.key}`}>
          <span className="filter-chip-label">{it.label}</span>
          <button type="button" className="chip-x" aria-label={`Remove filter ${it.label}`} data-testid={`active-remove-${it.key}`} onClick={it.remove}>
            &times;
          </button>
        </span>
      ))}
      <button type="button" className="btn" data-testid="filters-clear-all" onClick={clearFilters}>
        Clear all
      </button>
    </div>
  );
}

export function activeFilterTotal(columnFilters: Partial<Record<ColumnId, ColumnFilter>>, quick: { mine?: boolean; overdue?: boolean }): number {
  let n = (quick.mine ? 1 : 0) + (quick.overdue ? 1 : 0);
  for (const col of FILTER_COLUMNS) if (!isFilterEmpty(columnFilters[col.id])) n += 1;
  return n;
}

interface SheetProps {
  /** rows after the status chip, before the column filters: the option source (as on the web) */
  tableRows: readonly TaskTableRow[];
  quickCounts: { mine: number; overdue: number };
  resultCount: number;
  views: readonly SavedView[];
  buildings: readonly { id: string; name: string }[];
  firstBuildingId: string | null;
  onClose: () => void;
}

/**
 * Filters sheet (bottom sheet on phones and portrait, side panel on landscape tablets). One section per registry column with a
 * `filterKind`; each edits the same `ActiveFilters` shape the web uses, so the shared `applyColumnFilters` does the work.
 */
export function FilterSheet({ tableRows, quickCounts, resultCount, buildings, firstBuildingId, onClose }: SheetProps) {
  const { columnFilters, quick, sort, viewId, scopeBuildingId, setColumnFilter, setQuick, setSort, setScopeBuilding, clearFilters } = useListStore();
  const [open, setOpen] = useState<ReadonlySet<ColumnId>>(() => new Set(FILTER_COLUMNS.filter((c) => !isFilterEmpty(columnFilters[c.id])).map((c) => c.id)));
  const toggleOpen = (id: ColumnId) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <Sheet title="Filters" onClose={onClose} testId="filter-sheet" side>
      <h3>Sort</h3>
      <div className="chips">
        {SORT_CHOICES.map((o) => (
          <button key={o.id} type="button" className={`chip${sort === o.id ? " is-on" : ""}`} aria-pressed={sort === o.id} data-testid={`sort-${o.id}`} onClick={() => setSort(o.id)}>
            {o.label}
          </button>
        ))}
      </div>
      <h3>Quick</h3>
      <div className="chips">
        <button type="button" className={`chip${quick.mine ? " is-on" : ""}`} aria-pressed={!!quick.mine} data-testid="quick-mine" onClick={() => setQuick({ ...quick, mine: !quick.mine })}>
          Mine ({quickCounts.mine})
        </button>
        <button type="button" className={`chip${quick.overdue ? " is-on" : ""}`} aria-pressed={!!quick.overdue} data-testid="quick-overdue" onClick={() => setQuick({ ...quick, overdue: !quick.overdue })}>
          Overdue ({quickCounts.overdue})
        </button>
      </div>
      {viewId === "building" && buildings.length > 1 && (
        <>
          <h3>Building for “This building”</h3>
          <div className="chips">
            {buildings.map((b) => {
              const on = (scopeBuildingId ?? firstBuildingId) === b.id;
              return (
                <button key={b.id} type="button" className={`chip${on ? " is-on" : ""}`} aria-pressed={on} data-testid={`scope-building-${b.id}`} onClick={() => setScopeBuilding(b.id)}>
                  {b.name}
                </button>
              );
            })}
          </div>
        </>
      )}
      <h3>Columns</h3>
      <ul className="filter-cols">
        {FILTER_COLUMNS.map((col) => {
          const f = columnFilters[col.id];
          const count = filterSelectionCount(f);
          const isOpen = open.has(col.id);
          return (
            <li key={col.id} className="filter-col" data-testid={`filter-col-${col.id}`}>
              <button type="button" className="filter-col-head" aria-expanded={isOpen} data-testid={`filter-head-${col.id}`} onClick={() => toggleOpen(col.id)}>
                <span>{col.label}</span>
                {count > 0 && <span className="count-badge" data-testid={`filter-count-${col.id}`}>{count}</span>}
                <span className="caret" aria-hidden="true">{isOpen ? "–" : "+"}</span>
              </button>
              {isOpen && <ColumnEditor col={col} filter={f} rows={tableRows} onChange={(next) => setColumnFilter(col.id, next)} />}
            </li>
          );
        })}
      </ul>
      <div className="sheet-actions">
        <button type="button" className="btn" data-testid="filter-clear" onClick={clearFilters}>
          Clear all
        </button>
        <button type="button" className="btn primary" data-testid="filter-show" onClick={onClose}>
          Show {resultCount} task{resultCount === 1 ? "" : "s"}
        </button>
      </div>
    </Sheet>
  );
}

function toggle<T>(list: readonly T[], v: T): T[] {
  return list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
}

function ColumnEditor({ col, filter, rows, onChange }: { col: TableColumn; filter: ColumnFilter | undefined; rows: readonly TaskTableRow[]; onChange(f: ColumnFilter | undefined): void }) {
  const kind = col.filterKind!;
  const cur = filter && filter.kind === kind ? filter : emptyFilter(kind);
  const id = col.id;
  const options = useMemo(() => (kind === "distinct" ? distinctOptions(rows, id) : []), [kind, rows, id]);
  if (cur.kind === "distinct") {
    return (
      <div className="chips filter-col-body">
        {options.length === 0 && <span className="muted tiny">No values</span>}
        {options.map((o) => {
          const on = cur.keys.includes(o.key);
          return (
            <button key={o.key} type="button" className={`chip${on ? " is-on" : ""}`} aria-pressed={on} data-testid={`fopt-${id}-${o.key}`} onClick={() => onChange({ kind: "distinct", keys: toggle(cur.keys, o.key) })}>
              {o.label} <span className="chip-count">{o.count}</span>
            </button>
          );
        })}
      </div>
    );
  }
  if (cur.kind === "deadline") {
    return (
      <div className="chips filter-col-body">
        {DEADLINE_PRESETS.map((p: DeadlinePresetKey) => {
          const on = cur.presets.includes(p);
          return (
            <button key={p} type="button" className={`chip${on ? " is-on" : ""}`} aria-pressed={on} data-testid={`fopt-${id}-${p}`} onClick={() => onChange({ kind: "deadline", presets: toggle(cur.presets, p) })}>
              {DEADLINE_PRESET_LABELS[p]}
            </button>
          );
        })}
      </div>
    );
  }
  if (cur.kind === "date") {
    return (
      <div className="chips filter-col-body">
        {DATE_PRESETS.map((p: DatePresetKey) => {
          const on = cur.presets.includes(p);
          return (
            <button key={p} type="button" className={`chip${on ? " is-on" : ""}`} aria-pressed={on} data-testid={`fopt-${id}-${p}`} onClick={() => onChange({ kind: "date", presets: toggle(cur.presets, p) })}>
              {DATE_PRESET_LABELS[p]}
            </button>
          );
        })}
      </div>
    );
  }
  if (cur.kind === "contains") {
    return (
      <div className="filter-col-body">
        <input type="text" className="input" aria-label={`${col.label} contains`} placeholder={`${col.label} contains...`} data-testid={`fcontains-${id}`} value={cur.query} onChange={(e) => onChange({ kind: "contains", query: e.target.value })} />
      </div>
    );
  }
  const num = (v: string): number | null => (v.trim() === "" || Number.isNaN(Number(v)) ? null : Number(v));
  return (
    <div className="filter-col-body filter-range">
      <input type="number" inputMode="numeric" className="input" aria-label={`${col.label} minimum`} placeholder="Min" data-testid={`fmin-${id}`} value={cur.min ?? ""} onChange={(e) => onChange({ kind: "number", min: num(e.target.value), max: cur.max })} />
      <input type="number" inputMode="numeric" className="input" aria-label={`${col.label} maximum`} placeholder="Max" data-testid={`fmax-${id}`} value={cur.max ?? ""} onChange={(e) => onChange({ kind: "number", min: cur.min, max: num(e.target.value) })} />
    </div>
  );
}
