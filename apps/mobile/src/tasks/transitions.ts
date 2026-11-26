import { isLegal, legalVerbs, type TaskStatus, type TaskVerb } from "@ff/tasks";

/**
 * Status changes offered on the detail screen. Only verbs that move the
 * status; `comment`, `edit` and `assign` have their own controls. The legal
 * set always comes from the shared state machine (`@ff/tasks` status.ts), so
 * the UI cannot offer a transition the rules would reject.
 */
export interface StatusAction {
  verb: TaskVerb;
  label: string;
  /** visual weight */
  tone: "primary" | "neutral" | "danger";
}

const ACTIONS: Record<string, StatusAction> = {
  complete: { verb: "complete", label: "Submit for approval", tone: "primary" },
  approve: { verb: "approve", label: "Approve", tone: "primary" },
  followup: { verb: "followup", label: "Approve with follow-up", tone: "neutral" },
  reject: { verb: "reject", label: "Send back to work", tone: "neutral" },
  discontinue: { verb: "discontinue", label: "Discontinue", tone: "danger" },
};

const ORDER: readonly TaskVerb[] = ["complete", "approve", "followup", "reject", "discontinue"];

export function statusActionsFor(status: number | null): StatusAction[] {
  if (status === null) return [];
  const legal = new Set(legalVerbs(status as TaskStatus));
  return ORDER.filter((v) => legal.has(v)).map((v) => ACTIONS[v]);
}

export function canComment(status: number | null): boolean {
  return status !== null && isLegal("comment", status as TaskStatus);
}

export function canEdit(status: number | null): boolean {
  return status !== null && isLegal("edit", status as TaskStatus);
}

export function canAssign(status: number | null): boolean {
  return status !== null && isLegal("assign", status as TaskStatus);
}
