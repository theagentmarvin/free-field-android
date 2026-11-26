import { useLiveQuery } from "dexie-react-hooks";
import type { OutboxRecord } from "@ff/types";
import { db } from "@ff/data/db/database";
import { useProjectId } from "@ff/auth";
import { outboxCounts, type OutboxCounts } from "./outboxModel";

const EMPTY: OutboxRecord[] = [];

/** All non-discarded outbox rows of the current project (live). */
export function useOutboxRows(): OutboxRecord[] {
  const projectId = useProjectId();
  return (
    useLiveQuery(
      async () => (projectId ? (await db.outbox.where("projectId").equals(projectId).toArray()).filter((r) => r.state !== "killed") : EMPTY),
      [projectId],
    ) ?? EMPTY
  );
}

export function useOutboxCounts(): OutboxCounts {
  const rows = useOutboxRows();
  return outboxCounts(rows);
}
