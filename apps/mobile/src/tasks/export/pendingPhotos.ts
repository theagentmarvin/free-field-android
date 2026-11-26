import { composePhotoPath, type TaskActionPayload } from "@ff/tasks";
import type { OutboxRecord } from "@ff/types";

/** Photos still waiting in the outbox: storage path -> blob key, and queued entry (client guid) -> its photo paths. */
export interface PendingPhotoIndex {
  pendingKeys: Map<string, string>;
  byGuid: Map<string, string[]>;
}

export function indexPendingPhotos(rows: readonly OutboxRecord[]): PendingPhotoIndex {
  const pendingKeys = new Map<string, string>();
  const byGuid = new Map<string, string[]>();
  for (const r of rows) {
    if (r.state === "sent" || r.state === "killed") continue;
    const p = r.payload as unknown as TaskActionPayload;
    if (!p?.photoRefs?.length) continue;
    const paths = p.photoRefs.map((ref, i) => {
      const path = composePhotoPath(p.projectId, p.taskId, i, ref.sha256, ref.mime);
      pendingKeys.set(path, ref.blobKey);
      return path;
    });
    byGuid.set(p.clientGuid, paths);
  }
  return { pendingKeys, byGuid };
}
