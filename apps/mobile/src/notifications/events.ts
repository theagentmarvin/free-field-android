import type { Task, TaskEntry } from "@ff/firestore";
import { formatTaskNum, mentionedUids, STATUS_LABELS } from "@ff/tasks-react";
import type { NotifyCategory } from "./settings";

/**
 * Pure event derivation for on-device task notifications. Nothing here touches the clock, storage or the OS:
 * the engine feeds it task snapshots and timeline entries and gets events (or plans) back.
 */

export interface Me {
  uid: string;
  name: string;
}

export type EventKind = "assigned" | "status" | "comment" | "mention" | "deadline-today" | "deadline-overdue";

export interface NotifyEvent {
  /** dedupe key: `<taskId>:<entryId>` for timeline events, `<taskId>:<day>` for deadlines */
  id: string;
  kind: EventKind;
  category: NotifyCategory;
  taskId: string;
  num: string;
  title: string;
  /** one-line summary for the grouped notification */
  line: string;
  /** notification title / body when shown on its own */
  headline: string;
  body: string;
  at: number;
}

// ── Baseline: what this device already knew about each task ──────────

export interface TaskSnap {
  /** entryCount */
  n: number;
  /** status */
  s: number;
  /** assigneeUid */
  a: string | null;
}

export interface Baseline {
  tasks: Record<string, TaskSnap>;
  /** newest task.updatedAt processed; tasks unknown to `tasks` use it to tell "new" from "older, newly in view" */
  mark: number;
}

export function snapOf(t: Pick<Task, "entryCount" | "status" | "assigneeUid">): TaskSnap {
  return { n: t.entryCount, s: t.status, a: t.assigneeUid };
}

export function seedBaseline(tasks: readonly Task[]): Baseline {
  const out: Baseline = { tasks: {}, mark: 0 };
  for (const t of tasks) {
    out.tasks[t.id] = snapOf(t);
    out.mark = Math.max(out.mark, t.updatedAt);
  }
  return out;
}

/** Tasks whose timeline must be read: more entries than before, or never seen (new, or older and newly in view). */
export function tasksNeedingEntries(base: Baseline, tasks: readonly Task[]): Task[] {
  return tasks.filter((t) => {
    const prev = base.tasks[t.id];
    if (!prev) return t.updatedAt > base.mark;
    return t.entryCount > prev.n;
  });
}

/** The timeline entries this device has not seen yet. */
export function unseenEntries(task: Task, prev: TaskSnap | undefined, entries: readonly TaskEntry[], mark: number): TaskEntry[] {
  const sorted = [...entries].sort((a, b) => a.at - b.at);
  if (prev) return sorted.slice(Math.max(0, sorted.length - Math.max(0, task.entryCount - prev.n)));
  return sorted.filter((e) => e.at > mark);
}

/** Fold the processed tasks into the baseline. */
export function advanceBaseline(base: Baseline, tasks: readonly Task[]): Baseline {
  const next: Baseline = { tasks: { ...base.tasks }, mark: base.mark };
  for (const t of tasks) {
    next.tasks[t.id] = snapOf(t);
    next.mark = Math.max(next.mark, t.updatedAt);
  }
  return next;
}

// ── Timeline entries -> events ───────────────────────────────────────

const MAX_TEXT = 140;

export function clip(text: string, max = MAX_TEXT): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function involved(task: Task, me: Me): boolean {
  return task.createdByUid === me.uid || task.assigneeUid === me.uid;
}

/**
 * Events for the unseen `entries` of `task`. Never for my own entries. One event per entry, strongest reason first:
 * assigned to me, @mentioned, a comment on a task I am involved in, a status change on a task I created or am assigned.
 */
export function deriveEvents(task: Task, prev: TaskSnap | undefined, entries: readonly TaskEntry[], me: Me): NotifyEvent[] {
  const out: NotifyEvent[] = [];
  const num = formatTaskNum(task.num);
  const base = { taskId: task.id, num, title: task.title };
  let assignee = prev?.a ?? null;
  for (const e of entries) {
    const who = e.by || "Someone";
    const id = `${task.id}:${e.id}`;
    const wasAssignedToMe = assignee === me.uid;
    if (e.action === "assign" || e.action === "create") assignee = task.assigneeUid;
    if (e.byUid === me.uid) continue;

    if ((e.action === "create" || e.action === "assign") && task.assigneeUid === me.uid && !wasAssignedToMe) {
      out.push({ ...base, id, kind: "assigned", category: "assigned", at: e.at, line: `${num} assigned to you`, headline: `${num} assigned to you`, body: `${task.title} · by ${who}` });
      continue;
    }
    if (e.action === "comment" && e.text) {
      if (mentionedUids(e.text, [{ uid: me.uid, name: me.name }]).includes(me.uid)) {
        out.push({ ...base, id, kind: "mention", category: "comments", at: e.at, line: `${who} mentioned you on ${num}`, headline: `${who} mentioned you in ${num}`, body: clip(e.text) });
        continue;
      }
      if (involved(task, me)) {
        out.push({ ...base, id, kind: "comment", category: "comments", at: e.at, line: `${who} commented on ${num}`, headline: `${who} commented on ${num}`, body: clip(e.text) });
        continue;
      }
    }
    if (e.statusTo != null && e.statusFrom !== e.statusTo && e.action !== "create" && involved(task, me)) {
      const label = STATUS_LABELS[e.statusTo] ?? `status ${e.statusTo}`;
      out.push({ ...base, id, kind: "status", category: "status", at: e.at, line: `${num} moved to ${label}`, headline: `${num} moved to ${label}`, body: `${task.title} · by ${who}` });
    }
  }
  return out;
}

// ── Dedupe ledger ────────────────────────────────────────────────────

export const SEEN_CAP = 500;

/** Drop events already raised; returns the new events and the updated ledger (newest last, capped). */
export function dedupe(events: readonly NotifyEvent[], seen: readonly string[]): { fresh: NotifyEvent[]; seen: string[] } {
  const known = new Set(seen);
  const fresh: NotifyEvent[] = [];
  for (const ev of events) {
    if (known.has(ev.id)) continue;
    known.add(ev.id);
    fresh.push(ev);
  }
  const all = [...seen, ...fresh.map((e) => e.id)];
  return { fresh, seen: all.length > SEEN_CAP ? all.slice(all.length - SEEN_CAP) : all };
}

// ── Deadlines ────────────────────────────────────────────────────────

export const CLOSED = new Set([65, 80]);
export const REMINDER_HOUR = 8;

export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function at8(dayStart: number, plusDays: number): number {
  const d = new Date(dayStart);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + plusDays, REMINDER_HOUR, 0, 0, 0).getTime();
}

/** Open tasks that are mine: assigned to me, or created by me and not assigned to anyone. */
export function isMyOpenTask(t: Task, me: Me): boolean {
  if (CLOSED.has(t.status) || t.deadline == null) return false;
  return t.assigneeUid === me.uid || (t.assigneeUid == null && t.createdByUid === me.uid);
}

export interface DeadlinePlan {
  /** due today or overdue and not yet reminded today */
  now: NotifyEvent[];
  /** a daily local alarm per task: first due on the deadline day (or tomorrow when already due), 08:00 */
  schedule: Array<{ taskId: string; num: string; title: string; at: number; dueLabel: string }>;
  /** updated per-task ledger (taskId -> last reminded day), pruned to current candidates */
  ledger: Record<string, string>;
}

export function planDeadlines(tasks: readonly Task[], me: Me, nowMs: number, ledger: Record<string, string>): DeadlinePlan {
  const today = dayKey(nowMs);
  const today0 = startOfDay(nowMs);
  const plan: DeadlinePlan = { now: [], schedule: [], ledger: {} };
  for (const t of tasks) {
    if (!isMyOpenTask(t, me)) continue;
    const due0 = startOfDay(t.deadline!);
    const num = formatTaskNum(t.num);
    const dueLabel = new Date(t.deadline!).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    if (due0 <= today0) {
      const overdue = due0 < today0;
      if (ledger[t.id] !== today) {
        plan.now.push({
          id: `${t.id}:${today}`,
          kind: overdue ? "deadline-overdue" : "deadline-today",
          category: "deadlines",
          taskId: t.id,
          num,
          title: t.title,
          at: nowMs,
          line: `${num} ${overdue ? "overdue" : "due today"}`,
          headline: `${num} is ${overdue ? "overdue" : "due today"}`,
          body: `${t.title} · due ${dueLabel}`,
        });
      }
      plan.ledger[t.id] = today;
      plan.schedule.push({ taskId: t.id, num, title: t.title, at: at8(today0, 1), dueLabel });
    } else {
      if (ledger[t.id]) plan.ledger[t.id] = ledger[t.id]!;
      plan.schedule.push({ taskId: t.id, num, title: t.title, at: at8(due0, 0), dueLabel });
    }
  }
  return plan;
}

// ── Batching into notification plans ─────────────────────────────────

export const SUMMARY_FROM = 3;

export interface NotificationPlan {
  id: number;
  title: string;
  body: string;
  /** hash route to open on tap */
  path: string;
  /** the project the notification belongs to; the tap switches to it first when another project is current */
  projectId: string;
  group: string;
  channel: "tasks" | "deadlines";
  /** expanded lines for a summary */
  lines?: string[];
  summary?: boolean;
}

/** FNV-1a, folded into a positive 31-bit int (Android notification ids are ints). */
export function notificationId(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) & 0x7fffffff;
}

/** One notification per event, or a single grouped summary once a burst reaches SUMMARY_FROM events. */
export function planNotifications(events: readonly NotifyEvent[], projectId: string, projectName: string, stamp: number): NotificationPlan[] {
  if (events.length === 0) return [];
  const group = `project:${projectId}`;
  if (events.length >= SUMMARY_FROM) {
    const noun = events.every((e) => e.category === "deadlines") ? "deadline reminder" : "task update";
    // "Ana commented on T012" five times reads better as one line with a count
    const counts = new Map<string, number>();
    for (const e of events) counts.set(e.line, (counts.get(e.line) ?? 0) + 1);
    const lines = [...counts].map(([line, n]) => (n > 1 ? `${line} (x${n})` : line));
    return [
      {
        id: notificationId(`summary:${projectId}:${stamp}`),
        title: `${events.length} ${noun}${events.length === 1 ? "" : "s"} in ${projectName}`,
        body: lines.slice(0, 3).join(" · ") + (lines.length > 3 ? ` · +${lines.length - 3} more` : ""),
        path: "/tasks",
        projectId,
        group,
        channel: events.every((e) => e.category === "deadlines") ? "deadlines" : "tasks",
        lines,
        summary: true,
      },
    ];
  }
  return events.map((e) => ({
    id: notificationId(`event:${e.id}`),
    title: e.headline,
    body: e.body,
    path: `/tasks/${encodeURIComponent(e.taskId)}`,
    projectId,
    group,
    channel: e.category === "deadlines" ? ("deadlines" as const) : ("tasks" as const),
  }));
}
