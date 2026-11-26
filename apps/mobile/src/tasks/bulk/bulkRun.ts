import { buildActionPayload, type TaskActionPayload, type TaskStatus } from "@ff/tasks";
import type { BulkPlan, PlannedAction, SkipReason } from "@ff/tasks-react";

/**
 * Running a bulk plan through the outbox, and the summary text. Planning (what is allowed, the patches, the undo) is the web's
 * `planBulk`; this file only turns each planned action into the same `buildActionPayload` a single edit enqueues, then words the
 * result ("12 updated, 2 skipped: not allowed in this status").
 */

export const SKIP_TEXT: Record<SkipReason, string> = {
  illegal: "not allowed in this status",
  closed: "task is closed",
  unchanged: "already set",
  pending: "still syncing",
};

export interface BulkOutcome {
  /** label of the change, e.g. "Assignee" */
  label: string;
  updated: number;
  failed: number;
  skipped: { reason: SkipReason; count: number }[];
  /** planned undo actions for the rows that were updated */
  undo: PlannedAction[];
}

export function countSkips(plan: BulkPlan): BulkOutcome["skipped"] {
  const by = new Map<SkipReason, number>();
  for (const s of plan.skipped) by.set(s.reason, (by.get(s.reason) ?? 0) + 1);
  return [...by.entries()].map(([reason, count]) => ({ reason, count }));
}

/** "12 updated, 2 skipped: not allowed in this status" / "3 updated, 3 skipped: 2 task is closed, 1 already set" */
export function summarizeBulk(o: Pick<BulkOutcome, "updated" | "failed" | "skipped">): string {
  const skippedTotal = o.skipped.reduce((n, s) => n + s.count, 0);
  const parts: string[] = [`${o.updated} updated`];
  if (skippedTotal > 0) {
    const detail = o.skipped.length === 1 ? SKIP_TEXT[o.skipped[0]!.reason] : o.skipped.map((s) => `${s.count} ${SKIP_TEXT[s.reason]}`).join(", ");
    parts.push(`${skippedTotal} skipped: ${detail}`);
  }
  if (o.failed > 0) parts.push(`${o.failed} failed`);
  return parts.join(", ");
}

export interface BulkContext {
  projectId: string;
  actor: { uid: string; name: string };
  enqueue(p: TaskActionPayload): Promise<unknown>;
}

export function payloadOf(a: PlannedAction, ctx: Pick<BulkContext, "projectId" | "actor">): TaskActionPayload {
  return buildActionPayload({
    verb: a.verb,
    projectId: ctx.projectId,
    taskId: a.taskId,
    statusFrom: a.statusFrom as TaskStatus,
    actor: ctx.actor,
    title: a.title,
    text: a.text,
    patch: a.patch,
  });
}

/** Enqueue every planned action, one outbox action each. A row that turned illegal meanwhile counts as failed, not fatal. */
export async function runBulkPlan(label: string, plan: BulkPlan, ctx: BulkContext): Promise<BulkOutcome> {
  let failed = 0;
  const done: PlannedAction[] = [];
  for (const a of plan.actions) {
    try {
      await ctx.enqueue(payloadOf(a, ctx));
      done.push(a);
    } catch {
      failed += 1;
    }
  }
  return { label, updated: done.length, failed, skipped: countSkips(plan), undo: done.flatMap((a) => (a.undo ? [a.undo] : [])) };
}

export async function runUndo(undo: readonly PlannedAction[], ctx: BulkContext): Promise<{ reverted: number; failed: number }> {
  let reverted = 0;
  let failed = 0;
  for (const a of undo) {
    try {
      await ctx.enqueue(payloadOf(a, ctx));
      reverted += 1;
    } catch {
      failed += 1;
    }
  }
  return { reverted, failed };
}
