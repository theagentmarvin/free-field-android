import {
  normalizeChecklist,
  normalizeWatchers,
  TASK_PRIORITIES,
  type ChecklistItem,
  type TaskActionPayload,
  type TaskPriority,
  type TaskView,
} from "@ff/tasks";
import { buildTaskEdit } from "./edits";

/**
 * Priority, checklist and watchers on the New task screen. The shared compose model (and its draft row) does not carry them,
 * so they ride in a tiny per-draft localStorage map (like the markup link) and go out as ONE follow-up `edit` action right
 * after the `create`: the same additive task fields the detail view edits, nothing forked.
 */
export interface CreateExtras {
  priority: TaskPriority | null;
  checklist: ChecklistItem[];
  watchers: string[];
}

export const emptyExtras = (): CreateExtras => ({ priority: null, checklist: [], watchers: [] });

export const hasExtras = (e: CreateExtras): boolean => e.priority !== null || e.checklist.length > 0 || e.watchers.length > 0;

const KEY = "ffm.draftExtras.v1";

function readAll(): Record<string, unknown> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as unknown;
    return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function writeAll(m: Record<string, unknown>) {
  try {
    localStorage.setItem(KEY, JSON.stringify(m));
  } catch {
    /* the extras are a convenience: the draft itself is saved elsewhere */
  }
}

export function parseExtras(raw: unknown): CreateExtras {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const priority = TASK_PRIORITIES.includes(o.priority as TaskPriority) ? (o.priority as TaskPriority) : null;
  return { priority, checklist: normalizeChecklist(o.checklist), watchers: normalizeWatchers(o.watchers) };
}

export function loadExtras(taskId: string): CreateExtras {
  return parseExtras(readAll()[taskId]);
}

export function saveExtras(taskId: string, e: CreateExtras): void {
  const all = readAll();
  if (hasExtras(e)) all[taskId] = e;
  else if (taskId in all) delete all[taskId];
  else return;
  writeAll(all);
}

export function forgetExtras(taskId: string): void {
  const all = readAll();
  if (taskId in all) {
    delete all[taskId];
    writeAll(all);
  }
}

/** The follow-up edit that sets the extras on the task the `create` just queued (null when none were chosen). */
export function extrasEdit(
  extras: CreateExtras,
  created: { taskId: string; projectId: string; title: string; statusTo: number; actor: { uid: string; name: string }; at: number },
): TaskActionPayload | null {
  if (!hasExtras(extras)) return null;
  const base = {
    id: created.taskId,
    num: 0,
    title: created.title,
    status: created.statusTo,
    updatedAt: created.at,
    assigneeName: null,
    lastAction: "create",
    entryCount: 1,
  } as TaskView;
  return buildTaskEdit(
    base,
    {
      ...(extras.priority ? { priority: extras.priority } : {}),
      ...(extras.checklist.length > 0 ? { checklist: extras.checklist } : {}),
      ...(extras.watchers.length > 0 ? { watchers: extras.watchers } : {}),
    },
    { projectId: created.projectId, actor: created.actor, at: created.at + 2 },
  );
}
