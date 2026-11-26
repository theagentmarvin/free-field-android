import type { OutboxRecord, OutboxState } from "@ff/types";

/** Pure view-model helpers for the Outbox screen and the header chip. */

export interface OutboxCounts {
  /** Waiting or in flight (added + sending). */
  pending: number;
  failed: number;
  sent: number;
}

export function outboxCounts(rows: readonly OutboxRecord[]): OutboxCounts {
  const c: OutboxCounts = { pending: 0, failed: 0, sent: 0 };
  for (const r of rows) {
    if (r.state === "added" || r.state === "sending") c.pending += 1;
    else if (r.state === "failed") c.failed += 1;
    else if (r.state === "sent") c.sent += 1;
  }
  return c;
}

export const STATE_LABELS: Record<OutboxState, string> = {
  added: "Pending",
  sending: "Sending",
  failed: "Failed",
  sent: "Sent",
  killed: "Discarded",
};

export interface OutboxItem {
  id: string;
  state: OutboxState;
  label: string;
  stateLabel: string;
  error: string | null;
  attempts: number;
  createdAt: number;
  canRetry: boolean;
  canDiscard: boolean;
}

export interface OutboxGroup {
  key: string;
  title: string;
  items: OutboxItem[];
  /** createdAt of the newest item, used to order groups. */
  newest: number;
}

interface TaskPayloadLike {
  taskId?: unknown;
  title?: unknown;
  verb?: unknown;
}

const VERB_LABELS: Record<string, string> = {
  create: "Create task",
  comment: "Comment",
  edit: "Edit",
  assign: "Assign",
  complete: "Mark complete",
  reject: "Reject",
  approve: "Approve",
  followup: "Follow up",
  discontinue: "Discontinue",
};

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

export function describeVerb(row: OutboxRecord): string {
  const p = row.payload as TaskPayloadLike;
  const verb = str(p.verb);
  if (!verb) return row.kind;
  return VERB_LABELS[verb] ?? verb.charAt(0).toUpperCase() + verb.slice(1);
}

/** Entity a row belongs to: the task for task actions, else its kind. */
export function entityKey(row: OutboxRecord): string {
  const taskId = str((row.payload as TaskPayloadLike).taskId);
  return taskId ? `task:${taskId}` : `kind:${row.kind}`;
}

/**
 * Show every live row plus sent rows (recent history); discarded rows are
 * hidden. Items inside a group run oldest to newest, groups newest first.
 */
export function groupOutbox(rows: readonly OutboxRecord[]): OutboxGroup[] {
  const groups = new Map<string, OutboxGroup>();
  const visible = rows.filter((r) => r.state !== "killed").sort((a, b) => a.createdAt - b.createdAt);
  for (const row of visible) {
    const key = entityKey(row);
    let g = groups.get(key);
    if (!g) {
      const isTask = key.startsWith("task:");
      g = { key, title: isTask ? (str((row.payload as TaskPayloadLike).title) ?? "Task") : "Other changes", items: [], newest: 0 };
      groups.set(key, g);
    }
    g.items.push({
      id: row.id,
      state: row.state,
      label: describeVerb(row),
      stateLabel: STATE_LABELS[row.state],
      error: row.state === "failed" ? (row.lastError ?? "Unknown error") : null,
      attempts: row.attempts,
      createdAt: row.createdAt,
      canRetry: row.state === "failed",
      canDiscard: row.state === "failed" || row.state === "added",
    });
    g.newest = Math.max(g.newest, row.createdAt);
  }
  return [...groups.values()].sort((a, b) => b.newest - a.newest);
}

const CODE_TEXT: Record<string, string> = {
  "permission-denied": "You no longer have permission to make this change. Ask a project admin for access, then tap Retry.",
  unauthenticated: "You are signed out. Sign in again, then tap Retry.",
  "not-found": "What this change refers to no longer exists. You can discard it.",
  "resource-exhausted": "The server is limiting requests right now. Tap Retry in a few minutes.",
  "failed-precondition": "The server could not apply this change in its current state. Tap Retry, or discard it.",
};

/**
 * Text for a failed row. The engine stores Firebase errors as "[code] message"; the message of a rules rejection is an internal
 * evaluation trace ("evaluation error at L570:26 ..."), so known codes get a plain sentence and others lose only the prefix.
 */
export function friendlyError(lastError: string): string {
  const code = /^\[([^\]]+)\]/.exec(lastError)?.[1];
  if (code && CODE_TEXT[code]) return CODE_TEXT[code];
  return lastError.replace(/^\[[^\]]+\]\s*/, "") || lastError;
}
