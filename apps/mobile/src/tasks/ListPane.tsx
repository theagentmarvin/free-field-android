import { memo, useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent } from "react";
import { Link } from "react-router-dom";
import { PriorityChip, isOverdueDeadline, SAVED_VIEWS, TOOLBAR_CHIPS, draftTable, useTaskEngine } from "@ff/tasks-react";
import { useNetworkStatus } from "../platform/network";
import { deleteDraft, type DraftSummary } from "./drafts";
import { discardTaskPhotos } from "./photoStore";
import { useListStore } from "./listStore";
import { ActiveFilterChips, FilterSheet, activeFilterTotal } from "./filters";
import { Avatar, numLabel, StatusChip, SyncBadge, fmtDate, usePullToRefresh } from "./ui";
import { BulkBar, BulkResult } from "./bulk/BulkBar";
import type { BulkOutcome } from "./bulk/bulkRun";
import { createLongPress } from "./bulk/longPress";
import { allSelected, useSelection } from "./bulk/selection";
import { ConnectedExportSheet } from "./export/ExportSheet";
import { filterNote } from "./export/filterNote";
import type { TaskListResult } from "@ff/tasks-react";
import type { TaskView } from "@ff/tasks";

interface Props {
  tasks: TaskView[];
  loaded: boolean;
  /** more tasks exist beyond the current fetch limit */
  hasMore: boolean;
  onLoadMore(): void;
  drafts: DraftSummary[];
  /** the project's buildings (for the "This building" scope picker) */
  buildings?: readonly { id: string; name: string }[];
  firstBuildingId?: string | null;
  selectedId?: string;
  /** the shared pipeline's result for the current chip, search, saved view and filters */
  list: TaskListResult;
}

export function ListPane({ tasks, loaded, hasMore, onLoadMore, drafts, buildings = [], firstBuildingId = null, selectedId, list }: Props) {
  const { online } = useNetworkStatus();
  const engine = useTaskEngine();
  const { chip, search, viewId, quick, columnFilters, scope, scopeBuildingId, showDrafts, setChip, setSearch, applyView, setShowDrafts } = useListStore();
  const [sheet, setSheet] = useState(false);
  const visible = list.rows;
  const sel = useSelection();
  const [exportOpen, setExportOpen] = useState(false);
  const [outcome, setOutcome] = useState<{ outcome: BulkOutcome; text: string; seq: number } | null>(null);
  const outcomeSeq = useRef(0);
  const visibleIds = useMemo(() => visible.map((t) => t.id), [visible]);
  const selectedRows = useMemo(() => visible.filter((t) => sel.ids.has(t.id)), [visible, sel.ids]);
  const selecting = sel.active && !showDrafts;
  const filterCount = activeFilterTotal(columnFilters, quick);
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null);

  const ptr = usePullToRefresh(async () => {
    // The live queries are push-based; refreshing means kicking the outbox so
    // queued changes go out and failed-on-network rows are revived.
    await engine?.reviveNetworkFailed();
    await engine?.drain();
    setRefreshedAt(Date.now());
  });

  // rows that left the filtered list (a filter, a sync) are dropped from the selection
  useEffect(() => sel.prune(visibleIds), [visibleIds]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (showDrafts && sel.active) sel.exit();
  }, [showDrafts]); // eslint-disable-line react-hooks/exhaustive-deps

  const buildingName = (scopeBuildingId ?? firstBuildingId) ? (buildings.find((b) => b.id === (scopeBuildingId ?? firstBuildingId))?.name ?? null) : null;
  const note = () => filterNote({ chip, search, viewId, scope, buildingName, quick, columnFilterCount: activeFilterTotal(columnFilters, {}) });
  // stable handlers so memoised rows are not rebuilt on every render
  const toggleRow = useRef(sel.toggle);
  toggleRow.current = sel.toggle;
  const enterRow = useRef(sel.enter);
  enterRow.current = sel.enter;
  const onToggle = useRef((id: string) => toggleRow.current(id)).current;
  const onLongPress = useRef((id: string) => enterRow.current(id)).current;

  const now = Date.now();
  return (
    <div className="tasks-list" data-testid="tasks-list-pane" data-selecting={selecting ? "1" : "0"}>
      <div className="view-tabs" role="tablist" aria-label="Saved views" data-testid="view-tabs">
        {SAVED_VIEWS.map((v) => (
          <button
            key={v.id}
            type="button"
            role="tab"
            aria-selected={viewId === v.id}
            className={`view-tab${viewId === v.id ? " is-active" : ""}`}
            data-testid={`view-${v.id}`}
            onClick={() => applyView(v.id)}
          >
            {v.label}
          </button>
        ))}
      </div>
      {selecting ? (
        <div className="tasks-toolbar select-toolbar" data-testid="select-toolbar">
          <button
            type="button"
            className="btn"
            data-testid="select-all"
            aria-pressed={allSelected(sel, visibleIds)}
            onClick={() => (allSelected(sel, visibleIds) ? sel.clear() : sel.selectAll(visibleIds))}
          >
            {allSelected(sel, visibleIds) ? "Deselect all" : `Select all visible (${visibleIds.length})`}
          </button>
          <button type="button" className="btn" data-testid="select-clear" disabled={sel.ids.size === 0} onClick={() => sel.clear()}>
            Clear
          </button>
          <span className="grow" />
          <button type="button" className="btn primary" data-testid="select-done" onClick={() => sel.exit()}>
            Done
          </button>
        </div>
      ) : (
      <div className="tasks-toolbar">
        <input
          type="search"
          className="input"
          placeholder="Search tasks"
          aria-label="Search tasks"
          data-testid="task-search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button type="button" className="btn" data-testid="filter-button" onClick={() => setSheet(true)}>
          Filters
          {filterCount > 0 && (
            <span className="count-badge" data-testid="filter-badge">
              {filterCount}
            </span>
          )}
        </button>
        <button type="button" className="btn" data-testid="select-mode" disabled={showDrafts || visible.length === 0} onClick={() => sel.enter()}>
          Select
        </button>
        <button type="button" className="btn" data-testid="export-view" disabled={showDrafts || visible.length === 0} onClick={() => setExportOpen(true)}>
          Export
        </button>
        <Link to="/tasks/new" className="btn primary" data-testid="new-task">
          New task
        </Link>
      </div>
      )}
      <ActiveFilterChips />
      <div className="folder-tabs" role="tablist" aria-label="Task status" data-testid="status-chips">
        {TOOLBAR_CHIPS.map((c) => (
          <button
            key={String(c.id)}
            type="button"
            role="tab"
            aria-selected={!showDrafts && chip === c.id}
            className={`folder-tab${!showDrafts && chip === c.id ? " is-active" : ""}`}
            data-testid={`chip-${String(c.id)}`}
            onClick={() => setChip(c.id)}
          >
            {c.label}
            <span className="count">{list.counts[String(c.id)] ?? 0}</span>
          </button>
        ))}
        <button
          type="button"
          role="tab"
          aria-selected={showDrafts}
          className={`folder-tab${showDrafts ? " is-active" : ""}`}
          data-testid="folder-drafts"
          onClick={() => setShowDrafts(true)}
        >
          Drafts
          <span className="count">{drafts.length}</span>
        </button>
      </div>
      {!online && (
        <p className="banner" data-testid="offline-banner" role="status">
          Offline. You can still create and update tasks; they sync when you are back online.
        </p>
      )}
      <div className="tasks-scroll" ref={ptr.ref} {...ptr.handlers} data-testid="tasks-scroll">
        <div
          className="ptr"
          data-testid="ptr"
          data-state={ptr.busy ? "busy" : ptr.pull >= 70 ? "ready" : "idle"}
          style={{ height: ptr.busy ? 36 : ptr.pull }}
        >
          {ptr.busy ? "Syncing..." : ptr.pull >= 70 ? "Release to sync" : ptr.pull > 0 ? "Pull to sync" : ""}
        </div>
        {showDrafts ? (
          <DraftList drafts={drafts} />
        ) : !loaded ? (
          <p className="muted pad" data-testid="tasks-loading">
            Loading tasks...
          </p>
        ) : visible.length === 0 ? (
          <EmptyState hasTasks={tasks.length > 0} filtered={filterCount > 0 || search.trim() !== "" || viewId !== null || chip !== "all"} online={online} />
        ) : (
          <ul className="list" data-testid="task-list">
            {visible.map((t) => (
              <TaskRow
                key={t.id}
                id={t.id}
                num={t.num}
                title={t.title}
                status={t.status}
                deadline={t.deadline ?? null}
                overdue={t.deadline ? isOverdueDeadline(t.deadline, t.status, now) : false}
                buildingName={t.buildingName ?? null}
                storeyName={t.storeyName ?? null}
                photoCount={t.photos?.length ?? 0}
                pending={!!t.pending}
                failed={!!t.failed}
                assigneeName={t.assigneeName ?? null}
                priority={t.priority ?? null}
                checkDone={t.checklist ? t.checklist.filter((c) => c.done).length : 0}
                checkTotal={t.checklist?.length ?? 0}
                selected={selectedId === t.id}
                selecting={selecting}
                checked={selecting && sel.ids.has(t.id)}
                onToggle={onToggle}
                onLongPress={onLongPress}
              />
            ))}
          </ul>
        )}
        {hasMore && !showDrafts && loaded && (
          <div className="pad" data-testid="load-more-box">
            <p className="muted tiny" data-testid="load-more-note">
              Showing the {tasks.length} most recently updated tasks. Counts and search cover these only.
            </p>
            <button type="button" className="btn" data-testid="load-more" onClick={onLoadMore}>
              Load more tasks
            </button>
          </div>
        )}
        {refreshedAt && <p className="muted tiny pad">Synced {fmtDate(refreshedAt)}</p>}
      </div>
      {outcome && (
        <BulkResult
          key={outcome.seq}
          outcome={outcome.outcome}
          text={outcome.text}
          onDismiss={() => setOutcome(null)}
        />
      )}
      {selecting && selectedRows.length > 0 && (
        <BulkBar rows={selectedRows} onOutcome={(o, text) => setOutcome({ outcome: o, text, seq: ++outcomeSeq.current })} onClearSelection={() => sel.clear()} onExport={() => setExportOpen(true)} />
      )}
      {exportOpen && (
        <ConnectedExportSheet
          note={note}
          rows={selecting && selectedRows.length > 0 ? selectedRows : visible}
          scopeLabel={selecting && selectedRows.length > 0 ? "Selected tasks" : "Current view"}
          totalInView={selecting && selectedRows.length > 0 ? visible.length : undefined}
          onClose={() => setExportOpen(false)}
        />
      )}
      {sheet && (
        <FilterSheet
          tableRows={list.tableRows}
          quickCounts={list.quickCounts}
          resultCount={visible.length}
          views={SAVED_VIEWS}
          buildings={buildings}
          firstBuildingId={firstBuildingId}
          onClose={() => setSheet(false)}
        />
      )}
    </div>
  );
}

interface TaskRowProps {
  id: string;
  num: number;
  title: string;
  status: number;
  deadline: number | null;
  overdue: boolean;
  buildingName: string | null;
  storeyName: string | null;
  photoCount: number;
  pending: boolean;
  failed: boolean;
  assigneeName: string | null;
  priority: string | null;
  checkDone: number;
  checkTotal: number;
  selected: boolean;
  /** multi-select mode: rows show a checkbox and a tap toggles instead of opening */
  selecting: boolean;
  checked: boolean;
  onToggle(id: string): void;
  onLongPress(id: string): void;
}

/**
 * One list row. Memoized on primitives: the list re-renders on every outbox transition and every snapshot while a queue drains
 * (PERF-1), and with thousands of tasks loaded rebuilding every row dominated the drain time. Only the rows whose data changed
 * re-render now.
 */
const TaskRow = memo(function TaskRow(p: TaskRowProps) {
  const { id, selecting, onToggle, onLongPress } = p;
  const press = useMemo(() => createLongPress(() => onLongPress(id)), [id, onLongPress]);
  useEffect(() => press.cancel, [press]);
  const onClick = (e: MouseEvent) => {
    if (press.consumeClick()) {
      e.preventDefault(); // the press that opened select mode must not also open the task
      return;
    }
    if (selecting) {
      e.preventDefault();
      onToggle(id);
    }
  };
  const pointer = selecting
    ? {}
    : {
        onPointerDown: (e: PointerEvent) => press.onPointerDown(e),
        onPointerMove: (e: PointerEvent) => press.onPointerMove(e),
        onPointerUp: press.cancel,
        onPointerCancel: press.cancel,
        onPointerLeave: press.cancel,
      };
  return (
    <li>
      <Link
        to={`/tasks/${p.id}`}
        className={`row task-row${p.selected && !selecting ? " is-selected" : ""}${p.checked ? " is-checked" : ""}`}
        data-testid="task-row"
        data-task-id={p.id}
        data-status={p.status}
        data-checked={selecting ? (p.checked ? "1" : "0") : undefined}
        aria-selected={selecting ? p.checked : undefined}
        onClick={onClick}
        onContextMenu={(e) => e.preventDefault()}
        draggable={false}
        {...pointer}
      >
        {selecting && (
          <span className={`row-check${p.checked ? " is-on" : ""}`} data-testid="row-check" role="checkbox" aria-checked={p.checked} aria-label={`Select ${p.title}`}>
            {p.checked ? "\u2713" : ""}
          </span>
        )}
        <span className="task-row-main">
          <span className="task-row-top">
            <span className="num">{numLabel(p.num)}</span>
            <span className="task-title">{p.title}</span>
          </span>
          <span className="task-row-meta">
            <StatusChip status={p.status} />
            {p.priority && p.priority !== "normal" ? <PriorityChip priority={p.priority} /> : null}
            {p.deadline ? <span className={`due${p.overdue ? " is-overdue" : ""}`}>Due {fmtDate(p.deadline)}</span> : null}
            {p.buildingName ? <span className="muted">{p.buildingName}</span> : null}
            {p.storeyName ? <span className="muted">{p.storeyName}</span> : null}
            {p.checkTotal > 0 ? (
              <span className="muted" data-testid="row-checklist">
                {p.checkDone}/{p.checkTotal} done
              </span>
            ) : null}
            {p.photoCount > 0 ? <span className="muted">{p.photoCount} photo{p.photoCount > 1 ? "s" : ""}</span> : null}
          </span>
        </span>
        <SyncBadge pending={p.pending} failed={p.failed} />
        <Avatar name={p.assigneeName} />
      </Link>
    </li>
  );
});

function EmptyState({ hasTasks, filtered, online }: { hasTasks: boolean; filtered: boolean; online: boolean }) {
  const reset = useListStore((s) => s.reset);
  if (filtered && hasTasks) {
    return (
      <div className="empty" data-testid="tasks-empty" data-reason="filtered">
        <p>No tasks match your view, search or filters.</p>
        <button type="button" className="btn" data-testid="empty-clear" onClick={reset}>
          Clear filters
        </button>
      </div>
    );
  }
  return (
    <div className="empty" data-testid="tasks-empty" data-reason="none">
      <p>
        {online
          ? "No tasks in this project yet."
          : "No tasks on this device yet. Tasks download when you are online; you can still create new ones."}
      </p>
    </div>
  );
}

function DraftList({ drafts }: { drafts: DraftSummary[] }) {
  if (drafts.length === 0) {
    return (
      <div className="empty" data-testid="drafts-empty">
        <p>No drafts. Unsent tasks are saved here automatically.</p>
      </div>
    );
  }
  return (
    <ul className="list" data-testid="draft-list">
      {drafts.map((d) => (
        <li key={d.id} className="row task-row">
          <Link to={`/tasks/new?draft=${encodeURIComponent(d.id)}`} className="task-row-main grow" data-testid="draft-row">
            <span className="task-row-top">
              <span className="task-title">{d.title.trim() || "(untitled draft)"}</span>
            </span>
            <span className="task-row-meta">
              <span className="sync-badge is-draft">Draft</span>
              <span className="muted">Saved {fmtDate(d.updatedAt)}</span>
              {d.photoCount > 0 && <span className="muted">{d.photoCount} photo{d.photoCount > 1 ? "s" : ""}</span>}
            </span>
          </Link>
          <button
            type="button"
            className="btn"
            data-testid="draft-delete"
            onClick={() => {
              void deleteDraft(draftTable, d.id);
              void discardTaskPhotos(d.id).catch(() => undefined);
            }}
          >
            Delete
          </button>
        </li>
      ))}
    </ul>
  );
}
