import { useMemo, useState } from "react";
import { useProjectId } from "@ff/auth";
import { parseDateInput, PRIORITY_LABELS, TASK_PRIORITIES, type TaskVerb } from "@ff/tasks";
import { planBulk, TYPE_OPTIONS, useTaskEngine, type BulkOp, type BulkRowInput, type TaskTableRow } from "@ff/tasks-react";
import { useRoster } from "../hooks";
import { Avatar, Sheet } from "../ui";
import { runBulkPlan, runUndo, summarizeBulk, type BulkContext, type BulkOutcome } from "./bulkRun";

/**
 * Bulk actions on the selected tasks: status (through the workflow rules), assignee, deadline, priority and type. Each change is
 * planned by the web's `planBulk` and queued as the same outbox action a single edit uses, so it works offline and syncs later.
 */

type Panel = "status" | "assignee" | "deadline" | "priority" | "type" | "discontinue" | null;

/** Verbs the status sheet offers, with the wording used on the task detail screen. */
const STATUS_VERBS: { verb: TaskVerb; label: string; tone?: "danger" }[] = [
  { verb: "complete", label: "Submit for approval" },
  { verb: "approve", label: "Approve" },
  { verb: "followup", label: "Approve with follow-up" },
  { verb: "reject", label: "Send back to work" },
  { verb: "discontinue", label: "Discontinue", tone: "danger" },
];

export function useBulkContext(): BulkContext | null {
  const engine = useTaskEngine();
  const projectId = useProjectId();
  const { actor } = useRoster();
  return useMemo(() => (engine && projectId ? { projectId, actor, enqueue: (p) => engine.enqueue(p) } : null), [engine, projectId, actor]);
}

export interface BulkBarProps {
  rows: readonly TaskTableRow[];
  onOutcome(o: BulkOutcome, text: string): void;
  onClearSelection(): void;
  onExport(): void;
}

export function BulkBar({ rows, onOutcome, onClearSelection, onExport }: BulkBarProps) {
  const ctx = useBulkContext();
  const { members } = useRoster();
  const [panel, setPanel] = useState<Panel>(null);
  const [date, setDate] = useState("");
  const inputs = useMemo(() => rows.map((r) => r as unknown as BulkRowInput), [rows]);

  const apply = async (label: string, op: BulkOp, clear = false): Promise<void> => {
    setPanel(null);
    if (!ctx) return;
    const plan = planBulk(inputs, op);
    const outcome = await runBulkPlan(label, plan, ctx);
    onOutcome(outcome, summarizeBulk(outcome));
    if (clear) onClearSelection();
  };

  const eligible = (verb: TaskVerb): number => planBulk(inputs, { kind: "status", verb }).actions.length;

  const btn = (p: Exclude<Panel, null | "discontinue">, label: string) => (
    <button type="button" className="btn" data-testid={`bulk-${p}`} onClick={() => setPanel(p)}>
      {label}
    </button>
  );

  return (
    <>
      <div className="bulk-bar" role="toolbar" aria-label={`${rows.length} tasks selected`} data-testid="bulk-bar">
        <div className="bulk-top">
          <strong className="bulk-count" data-testid="bulk-count" data-count={rows.length}>
            {rows.length} selected
          </strong>
          <button type="button" className="btn primary" data-testid="bulk-export" onClick={onExport}>
            Export
          </button>
        </div>
        <div className="bulk-actions">
          {btn("status", "Status")}
          {btn("assignee", "Assignee")}
          {btn("deadline", "Deadline")}
          {btn("priority", "Priority")}
          {btn("type", "Type")}
        </div>
      </div>

      {panel === "status" && (
        <Sheet title={`Change status of ${rows.length}`} onClose={() => setPanel(null)} testId="bulk-status-sheet">
          <p className="muted tiny">Only tasks that may take the change are updated; the rest are skipped.</p>
          <ul className="list">
            {STATUS_VERBS.map((v) => {
              const n = eligible(v.verb);
              return (
                <li key={v.verb}>
                  <button
                    type="button"
                    className={`row${v.tone === "danger" ? " danger-text" : ""}`}
                    data-testid={`bulk-status-${v.verb}`}
                    disabled={n === 0}
                    onClick={() => (v.verb === "discontinue" ? setPanel("discontinue") : void apply("Status", { kind: "status", verb: v.verb }, true))}
                  >
                    <span className="grow">{v.label}</span>
                    <span className="muted tiny">
                      {n} of {rows.length}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </Sheet>
      )}

      {panel === "discontinue" && (
        <Sheet title={`Discontinue ${eligible("discontinue")} task${eligible("discontinue") === 1 ? "" : "s"}?`} onClose={() => setPanel(null)} testId="bulk-confirm-sheet">
          <p>Discontinued tasks are closed and cannot be reopened. This cannot be undone.</p>
          <div className="sheet-actions">
            <button type="button" className="btn danger" data-testid="bulk-confirm-discontinue" onClick={() => void apply("Status", { kind: "status", verb: "discontinue" }, true)}>
              Discontinue
            </button>
            <button type="button" className="btn" onClick={() => setPanel(null)}>
              Keep tasks
            </button>
          </div>
        </Sheet>
      )}

      {panel === "assignee" && (
        <Sheet title={`Assign ${rows.length} task${rows.length === 1 ? "" : "s"}`} onClose={() => setPanel(null)} testId="bulk-assignee-sheet">
          <ul className="list">
            <li>
              <button type="button" className="row" data-testid="bulk-assignee-none" onClick={() => void apply("Assignee", { kind: "assignee", uid: null, name: null })}>
                Unassign
              </button>
            </li>
            {members.map((m) => (
              <li key={m.uid}>
                <button type="button" className="row" data-testid={`bulk-assignee-${m.uid}`} onClick={() => void apply("Assignee", { kind: "assignee", uid: m.uid, name: m.name })}>
                  <Avatar name={m.name} /> {m.name}
                </button>
              </li>
            ))}
          </ul>
        </Sheet>
      )}

      {panel === "deadline" && (
        <Sheet title="Set deadline" onClose={() => setPanel(null)} testId="bulk-deadline-sheet">
          <label className="field">
            <span>Deadline</span>
            <input type="date" className="input" data-testid="bulk-deadline-input" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <div className="sheet-actions">
            <button
              type="button"
              className="btn primary"
              data-testid="bulk-deadline-apply"
              disabled={parseDateInput(date) === null}
              onClick={() => {
                const ts = parseDateInput(date);
                if (ts !== null) void apply("Deadline", { kind: "deadline", deadline: ts });
              }}
            >
              Apply to {rows.length}
            </button>
            <button type="button" className="btn" data-testid="bulk-deadline-clear" onClick={() => void apply("Deadline", { kind: "deadline", deadline: null })}>
              Remove deadline
            </button>
          </div>
        </Sheet>
      )}

      {panel === "priority" && (
        <Sheet title="Set priority" onClose={() => setPanel(null)} testId="bulk-priority-sheet">
          <ul className="list">
            {TASK_PRIORITIES.map((p) => (
              <li key={p}>
                <button type="button" className="row" data-testid={`bulk-priority-${p}`} onClick={() => void apply("Priority", { kind: "priority", priority: p })}>
                  {PRIORITY_LABELS[p]}
                </button>
              </li>
            ))}
          </ul>
        </Sheet>
      )}

      {panel === "type" && (
        <Sheet title="Set type" onClose={() => setPanel(null)} testId="bulk-type-sheet">
          <ul className="list">
            {TYPE_OPTIONS.map((t) => (
              <li key={t}>
                <button type="button" className="row" data-testid={`bulk-type-${t}`} onClick={() => void apply("Type", { kind: "type", type: t })}>
                  {t}
                </button>
              </li>
            ))}
          </ul>
        </Sheet>
      )}
    </>
  );
}

/** The result line under the list: the summary, and Undo while every changed row can be reversed. */
export function BulkResult({ outcome, text, onDismiss }: { outcome: BulkOutcome; text: string; onDismiss(): void }) {
  const ctx = useBulkContext();
  const [undone, setUndone] = useState<string | null>(null);
  const canUndo = outcome.undo.length > 0 && outcome.failed === 0 && !!ctx && undone === null;
  return (
    <div className="bulk-result" role="status" data-testid="bulk-result" data-updated={outcome.updated} data-skipped={outcome.skipped.reduce((n, s) => n + s.count, 0)} data-failed={outcome.failed}>
      <span className="grow" data-testid="bulk-result-text">
        {undone ?? text}
      </span>
      {canUndo && (
        <button
          type="button"
          className="btn"
          data-testid="bulk-undo"
          onClick={() =>
            void runUndo(outcome.undo, ctx!).then((r) => setUndone(`Reverted ${r.reverted} change${r.reverted === 1 ? "" : "s"}${r.failed > 0 ? `, ${r.failed} failed` : ""}`))
          }
        >
          Undo
        </button>
      )}
      <button type="button" className="btn" data-testid="bulk-result-dismiss" onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}
