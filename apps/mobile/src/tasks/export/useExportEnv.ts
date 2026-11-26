import { useCallback, useMemo, useRef } from "react";
import { useProjectId, useProjectSelection } from "@ff/auth";
import { mergeTaskEntries, type TaskEntryView } from "@ff/tasks";
import { loadMemberEmails, loadSheetCatalog, useOutboxRows, useTaskPhotoResolver, useTasksFirestore, useTasksSource } from "@ff/tasks-react";
import { useRoster } from "../hooks";
import { readEntriesOnce, type ExportEnv } from "./exportRun";
import { indexPendingPhotos } from "./pendingPhotos";

/** Everything an export reads, taken from the live hooks at the moment the export starts (never captured stale). */
export function useExportEnv(filterNote: () => string): () => ExportEnv | null {
  const source = useTasksSource();
  const db = useTasksFirestore();
  const projectId = useProjectId();
  const { memberships } = useProjectSelection();
  const rows = useOutboxRows(projectId);
  const resolver = useTaskPhotoResolver();
  const { actor, members } = useRoster();
  const live = useRef({ rows, resolver, actor, members, db, filterNote });
  live.current = { rows, resolver, actor, members, db, filterNote };
  const projectName = memberships?.find((m) => m.id === projectId)?.name ?? "FreeField";
  const names = useMemo(() => projectName, [projectName]);

  return useCallback((): ExportEnv | null => {
    if (!projectId) return null;
    const cur = live.current;
    return {
      projectId,
      projectName: names,
      actorName: cur.actor.name,
      filterNote: cur.filterNote(),
      source,
      async loadEntries(taskId: string): Promise<TaskEntryView[]> {
        const cloud = await readEntriesOnce(source, projectId, taskId);
        const mine = live.current.rows.filter((r) => (r.payload as { taskId?: string } | undefined)?.taskId === taskId);
        return mergeTaskEntries(cloud, mine, taskId, source.overlaySending);
      },
      pending: () => indexPendingPhotos(live.current.rows),
      images: { resolveUrl: async (p) => (live.current.resolver ? live.current.resolver(p) : null) },
      sheetNames: async () => (await loadSheetCatalog(projectId)).files,
      people: async () => [
        // offline the member read can stall: BCF authors fall back to display names
        ...(live.current.db ? await Promise.race([loadMemberEmails(live.current.db, projectId), new Promise<never[]>((r) => setTimeout(() => r([]), 3000))]) : []),
        ...live.current.members.map((m) => ({ uid: m.uid, name: m.name })),
      ],
    };
  }, [projectId, names, source]);
}
