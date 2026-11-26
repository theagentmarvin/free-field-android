import {
  buildActionPayload,
  buildEditPatch,
  diffTaskFields,
  normalizeChecklist,
  normalizeSheetRefs,
  normalizeWatchers,
  verbForEdit,
  type EditableTaskFields,
  type TaskActionPayload,
  type TaskStatus,
  type TaskView,
} from "@ff/tasks";
import type { TaskLocation } from "@ff/firestore";

/**
 * Field edits as ONE outbox action, exactly like the web detail editor:
 * diff against the (optimistic) task, `assign` when only the assignee changes
 * and it is legal, otherwise `edit`. Priority, checklist, watchers and attached
 * sheets are the additive task fields the rules now allow; hard delete is not offered.
 */
export type MobileEditable = Pick<
  EditableTaskFields,
  | "title"
  | "description"
  | "type"
  | "deadline"
  | "assigneeUid"
  | "assigneeName"
  | "buildingId"
  | "storeyName"
  | "priority"
  | "checklist"
  | "watchers"
  | "sheetRefs"
>;

export function buildTaskEdit(
  task: TaskView,
  next: Partial<MobileEditable>,
  ctx: { projectId: string; actor: { uid: string; name: string }; buildingName?: (id: string | null) => string | null; at?: number; guid?: string },
): TaskActionPayload | null {
  const loc = (task.location ?? null) as TaskLocation | null;
  const before: Partial<EditableTaskFields> = {
    title: task.title,
    description: task.description ?? "",
    type: task.type ?? "task",
    deadline: task.deadline ?? null,
    assigneeUid: task.assigneeUid ?? null,
    assigneeName: task.assigneeName ?? null,
    buildingId: task.buildingId ?? null,
    storeyName: loc?.storeyName ?? null,
    locationText: loc?.text ?? null,
    priority: task.priority as EditableTaskFields["priority"] | undefined,
    checklist: normalizeChecklist(task.checklist),
    watchers: normalizeWatchers(task.watchers),
    sheetRefs: normalizeSheetRefs(task.sheetRefs),
  };
  const changes = diffTaskFields(before, next, { buildingName: ctx.buildingName });
  if (changes.length === 0) return null;
  const verb = verbForEdit(task.status, changes);
  if (!verb) return null; // terminal
  const patch = buildEditPatch(next, changes, loc as Parameters<typeof buildEditPatch>[2]);
  return buildActionPayload({
    verb,
    projectId: ctx.projectId,
    taskId: task.id,
    statusFrom: task.status as TaskStatus,
    actor: ctx.actor,
    title: (patch.title as string | undefined) ?? task.title,
    text: changes.map((c) => c.text).join("; "),
    patch,
    at: ctx.at,
    guid: ctx.guid,
  });
}
