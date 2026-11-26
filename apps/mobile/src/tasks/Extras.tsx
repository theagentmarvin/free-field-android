import { useMemo, useState } from "react";
import {
  MAX_CHECKLIST_ITEMS,
  MAX_CHECKLIST_TEXT,
  PRIORITY_LABELS,
  TASK_PRIORITIES,
  checklistProgress,
  normalizeChecklist,
  normalizeSheetRefs,
  normalizeWatchers,
  priorityOf,
  type ChecklistItem,
  type SheetRef,
  type TaskPriority,
  type TaskView,
} from "@ff/tasks";
import {
  ChecklistProgress,
  PriorityChip,
  buildPickerSections,
  describeSheetRef,
  makeSheetRef,
  toggleSheetRef,
  type SheetCatalog,
  type TaskPerson,
} from "@ff/tasks-react";
import { Sheet } from "./ui";
import type { MobileEditable } from "./edits";

type Edit = (next: Partial<MobileEditable>) => void;

function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }
}

/** Priority chip, editable as four 44 px choices. Same field and values as the web. */
export function PriorityRow({ task, editable, onEdit }: { task: TaskView; editable: boolean; onEdit: Edit }) {
  const [open, setOpen] = useState(false);
  const cur = priorityOf(task.priority);
  return (
    <>
      <dt>Priority</dt>
      <dd>
        <button type="button" className="link-btn" data-testid="priority-button" disabled={!editable} onClick={() => setOpen(true)}>
          <span data-testid="detail-priority" data-priority={cur}>
            <PriorityChip priority={task.priority} />
          </span>
        </button>
        {open && (
          <Sheet title="Priority" onClose={() => setOpen(false)} testId="priority-sheet">
            <div className="chips">
              {TASK_PRIORITIES.map((p: TaskPriority) => (
                <button
                  key={p}
                  type="button"
                  className={`chip${cur === p ? " is-on" : ""}`}
                  aria-pressed={cur === p}
                  data-testid={`priority-${p}`}
                  onClick={() => {
                    onEdit({ priority: p });
                    setOpen(false);
                  }}
                >
                  {PRIORITY_LABELS[p]}
                </button>
              ))}
            </div>
          </Sheet>
        )}
      </dd>
    </>
  );
}

/** Checklist: check, uncheck, add and remove items. Every change enqueues ONE edit with the full next list (offline-safe). */
export function ChecklistSection({ task, editable, onEdit }: { task: TaskView; editable: boolean; onEdit: Edit }) {
  const items = useMemo(() => normalizeChecklist(task.checklist), [task.checklist]);
  const [text, setText] = useState("");
  const change = (next: ChecklistItem[]) => onEdit({ checklist: next });
  const add = () => {
    const t = text.trim().slice(0, MAX_CHECKLIST_TEXT);
    if (!t || items.length >= MAX_CHECKLIST_ITEMS) return;
    change([...items, { id: newId(), text: t, done: false }]);
    setText("");
  };
  if (items.length === 0 && !editable) return null;
  const { done, total } = checklistProgress(items);
  return (
    <section data-testid="detail-checklist" data-done={done} data-total={total}>
      <h3>
        Checklist <ChecklistProgress items={items} wide />
      </h3>
      <ul className="checklist">
        {items.map((it) => (
          <li key={it.id} className={`check-row${it.done ? " is-done" : ""}`}>
            <label className="check-main">
              <input
                type="checkbox"
                data-testid={`checklist-item-${it.id}`}
                checked={it.done}
                disabled={!editable}
                onChange={() => change(items.map((x) => (x.id === it.id ? { ...x, done: !x.done } : x)))}
              />
              <span className="check-text">{it.text}</span>
            </label>
            {editable && (
              <button type="button" className="chip-x" aria-label={`Remove ${it.text}`} data-testid={`checklist-remove-${it.id}`} onClick={() => change(items.filter((x) => x.id !== it.id))}>
                &times;
              </button>
            )}
          </li>
        ))}
      </ul>
      {editable && (
        <div className="row-inline">
          <input
            className="input"
            data-testid="checklist-new"
            aria-label="New checklist item"
            value={text}
            maxLength={MAX_CHECKLIST_TEXT}
            placeholder={items.length >= MAX_CHECKLIST_ITEMS ? "Checklist is full" : "Add an item"}
            disabled={items.length >= MAX_CHECKLIST_ITEMS}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
          />
          <button type="button" className="btn" data-testid="checklist-add" disabled={!text.trim()} onClick={add}>
            Add
          </button>
        </div>
      )}
    </section>
  );
}

/** Watchers: who follows the task, and a follow toggle for the signed-in user. */
export function WatchersSection({
  task,
  members,
  actorUid,
  editable,
  onEdit,
}: {
  task: TaskView;
  members: readonly TaskPerson[];
  actorUid: string | null;
  editable: boolean;
  onEdit: Edit;
}) {
  const watchers = normalizeWatchers(task.watchers);
  const following = !!actorUid && watchers.includes(actorUid);
  const name = (uid: string) => (uid === actorUid ? "You" : (members.find((m) => m.uid === uid)?.name ?? "Member"));
  if (watchers.length === 0 && !editable) return null;
  return (
    <section data-testid="detail-watchers" data-count={watchers.length}>
      <h3>Watchers · {watchers.length}</h3>
      {watchers.length > 0 && (
        <ul className="watchers">
          {watchers.map((uid) => (
            <li key={uid} data-testid="watcher">
              {name(uid)}
            </li>
          ))}
        </ul>
      )}
      {actorUid && (
        <button
          type="button"
          className="btn"
          data-testid="detail-follow"
          aria-pressed={following}
          disabled={!editable}
          onClick={() => onEdit({ watchers: following ? watchers.filter((u) => u !== actorUid) : [...watchers, actorUid] })}
        >
          {following ? "Unfollow" : "Follow this task"}
        </button>
      )}
    </section>
  );
}

/** Sheets attached by reference: shown with their version badge, opened in the Plans viewer, attachable from the project's sheets. */
export function SheetsSection({
  task,
  catalog,
  editable,
  onEdit,
  onOpen,
}: {
  task: TaskView;
  catalog: SheetCatalog;
  editable: boolean;
  onEdit: Edit;
  onOpen(ref: SheetRef): void;
}) {
  const refs = useMemo(() => normalizeSheetRefs(task.sheetRefs), [task.sheetRefs]);
  const [picker, setPicker] = useState(false);
  const [query, setQuery] = useState("");
  const sections = useMemo(() => (picker ? buildPickerSections(catalog, { buildingId: null, query }) : []), [picker, catalog, query]);
  if (refs.length === 0 && !editable) return null;
  const selected = (fileId: string) => refs.some((r) => r.pdfFileId === fileId);
  return (
    <section data-testid="detail-sheets" data-count={refs.length}>
      <h3>Sheets · {refs.length}</h3>
      <ul className="sheet-refs">
        {refs.map((r) => {
          const v = describeSheetRef(r, catalog);
          const key = `${r.pdfFileId}-${r.pdfVersionId}-${r.page ?? ""}`;
          return (
            <li key={key} className="sheet-ref" data-testid="sheet-ref" data-status={v.status}>
              <button type="button" className="row" data-testid={`sheet-open-${r.pdfFileId}`} disabled={v.status === "missing"} onClick={() => onOpen(r)}>
                <span className="grow">{v.name}</span>
                <span className="muted tiny">{v.label}</span>
              </button>
              {editable && (
                <button type="button" className="chip-x" aria-label={`Remove ${v.name}`} data-testid={`sheet-remove-${r.pdfFileId}`} onClick={() => onEdit({ sheetRefs: toggleSheetRef(refs, r) })}>
                  &times;
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {editable && (
        <button type="button" className="btn" data-testid="sheet-attach" onClick={() => setPicker(true)}>
          Attach from project
        </button>
      )}
      {picker && (
        <Sheet title="Attach sheets" onClose={() => setPicker(false)} testId="sheet-picker">
          <input className="input" type="search" aria-label="Search sheets" placeholder="Search sheets" data-testid="sheet-search" value={query} onChange={(e) => setQuery(e.target.value)} />
          {sections.length === 0 && <p className="muted">No sheets on this device. Make a building available offline first.</p>}
          {sections.map((sec) => (
            <div key={sec.title}>
              <h3>{sec.title}</h3>
              <ul className="list">
                {sec.entries.map((en) => {
                  const on = selected(en.fileId);
                  return (
                    <li key={en.fileId}>
                      <button
                        type="button"
                        className={`row${on ? " is-selected" : ""}`}
                        aria-pressed={on}
                        data-testid={`sheet-pick-${en.fileId}`}
                        onClick={() => {
                          const ref = makeSheetRef(en.fileId, catalog);
                          if (!ref) return;
                          onEdit({ sheetRefs: on ? refs.filter((r) => r.pdfFileId !== en.fileId) : toggleSheetRef(refs, ref) });
                        }}
                      >
                        <span className="grow">{en.name}</span>
                        <span className="muted tiny">{en.badge}</span>
                        {on && <span className="muted tiny"> attached</span>}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </Sheet>
      )}
    </section>
  );
}
