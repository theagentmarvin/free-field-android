import {
  clearDraft,
  loadDraft,
  saveDraft,
  TaskDraftFieldsSchema,
  type DraftTable,
} from "@ff/tasks";
import { restoreDraftCompose, toDraftFields, type ComposeFields, type DraftBlobReader } from "@ff/tasks-react";

/**
 * Compose drafts over the shared `@ff/tasks` drafts mechanism (Dexie `drafts`
 * table, drafts id == the future taskId). Autosaved while the form is dirty so
 * a killed app loses nothing; listed in the Drafts folder.
 */

/** A form with nothing typed/attached is not worth a draft row. */
export function isWorthSaving(f: ComposeFields): boolean {
  return (
    f.title.trim().length > 0 ||
    f.description.trim().length > 0 ||
    f.photos.length > 0 ||
    f.assigneeUid !== null ||
    f.deadline !== null
  );
}

export async function saveCompose(
  table: DraftTable,
  taskId: string,
  projectId: string,
  fields: ComposeFields,
  now = Date.now(),
): Promise<void> {
  await saveDraft(table, taskId, projectId, TaskDraftFieldsSchema.parse(toDraftFields(fields, projectId, taskId)), now);
}

/** Draft -> compose fields; photos are resolved from the durable blob store and dropped when their bytes are gone. */
export async function loadCompose(
  table: DraftTable,
  taskId: string,
  source?: DraftBlobReader,
): Promise<ComposeFields | undefined> {
  try {
    const d = await loadDraft(table, taskId);
    return d ? await restoreDraftCompose(d as Parameters<typeof restoreDraftCompose>[0], source) : undefined;
  } catch {
    return undefined; // corrupt row: treated as missing
  }
}

export const deleteDraft = clearDraft;

export interface DraftSummary {
  id: string;
  title: string;
  updatedAt: number;
  photoCount: number;
  storeyName: string | null;
}

export async function listDraftSummaries(table: DraftTable, projectId: string): Promise<DraftSummary[]> {
  const rows = await table.whereProject(projectId);
  const out: DraftSummary[] = [];
  for (const r of rows) {
    const parsed = TaskDraftFieldsSchema.safeParse(r.draft);
    if (!parsed.success) continue; // skip unreadable rows instead of failing the folder
    out.push({
      id: r.id,
      title: parsed.data.title,
      updatedAt: r.updatedAt,
      photoCount: parsed.data.photoPaths.length,
      storeyName: parsed.data.location?.storeyName ?? null,
    });
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}
