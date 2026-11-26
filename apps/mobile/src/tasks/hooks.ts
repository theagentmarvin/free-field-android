import { useCallback, useEffect, useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { isDemoAuth, useAuth, useProjectId } from "@ff/auth";
import { resolveActor } from "./identity";
import { listBuildings } from "@ff/data/db/tables/buildings";
import type { Task, TaskEntry } from "@ff/firestore";
import {
  composePhotoPath,
  mergeTaskEntries,
  mergeTaskViews,
  type TaskActionPayload,
  type TaskEntryView,
  type TaskView,
} from "@ff/tasks";
import {
  draftTable,
  useOutboxRows,
  useTaskPeople,
  useTasksFirestore,
  useTasksSource,
  type TaskPerson,
} from "@ff/tasks-react";
import type { OutboxRecord } from "@ff/types";
import { hasMoreTasks, nextLimit, TASK_PAGE } from "./paging";
import { LARGE_LIST, LARGE_LIST_THROTTLE_MS, useThrottledValue } from "./useThrottledValue";
import { listDraftSummaries, type DraftSummary } from "./drafts";

/**
 * Live task list: source docs merged with queued outbox actions (pending/failed flags).
 *
 * Two listeners (PERF-1): the newest TASK_PAGE tasks are always live; the bigger window that "Load more" grows (up to thousands of
 * tasks) is a second listener that is detached while the outbox has work in flight. The Firestore SDK's per-snapshot cost scales
 * with the size of the listened window (a 2,000-task window made each queued op cost about 2.5 s of main thread on the tablet, against
 * 0.3 s with 200), and a task that changes moves into the newest window anyway, so the older rows only lag until the queue is empty.
 */
export function useTaskList(): { tasks: TaskView[]; loaded: boolean; hasMore: boolean; loadMore(): void } {
  const source = useTasksSource();
  const projectId = useProjectId();
  const rows = useOutboxRows(projectId);
  const [live, setLive] = useState<Task[]>([]);
  const [big, setBig] = useState<Task[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [limit, setLimit] = useState(TASK_PAGE);
  const loadMore = useCallback(() => setLimit(nextLimit), []);
  const draining = useMemo(() => rows.some((r) => r.state === "added" || r.state === "sending"), [rows]);

  useEffect(() => {
    setLimit(TASK_PAGE);
    setBig([]);
  }, [projectId]);

  useEffect(() => {
    setLoaded(false);
    if (!projectId) {
      setLive([]);
      return;
    }
    let unsub = () => {};
    try {
      unsub = source.watchTasks(
        projectId,
        null,
        (t) => {
          setLive(t);
          setLoaded(true);
        },
        TASK_PAGE,
      );
    } catch {
      setLoaded(true); // no backend reachable: queued rows still show
    }
    return () => unsub();
  }, [source, projectId]);

  const wantBig = limit > TASK_PAGE && !!projectId && !draining;
  useEffect(() => {
    if (limit <= TASK_PAGE) setBig([]);
    if (!wantBig || !projectId) return;
    let unsub = () => {};
    try {
      unsub = source.watchTasks(projectId, null, setBig, limit);
    } catch {
      /* the live window still shows */
    }
    return () => unsub();
  }, [source, projectId, limit, wantBig]);

  const cloud = useMemo(() => {
    if (big.length === 0) return live;
    const ids = new Set(live.map((t) => t.id));
    return [...live, ...big.filter((t) => !ids.has(t.id))];
  }, [live, big]);

  // Large lists lag by up to a second behind a burst of changes (a draining queue), cloud docs and queue rows together so the
  // overlay never pairs a new snapshot with old rows.
  const inputs = useMemo(() => ({ cloud, rows }), [cloud, rows]);
  const shown = useThrottledValue(inputs, cloud.length > LARGE_LIST ? LARGE_LIST_THROTTLE_MS : 0);
  const tasks = useMemo(
    () => mergeTaskViews(shown.cloud as unknown as TaskView[], shown.rows, { overlaySending: source.overlaySending }),
    [shown, source.overlaySending],
  );
  const fetched = limit > TASK_PAGE ? big.length : live.length;
  return { tasks, loaded, hasMore: hasMoreTasks(fetched, limit), loadMore };
}

export interface TaskDetailData {
  task: TaskView | null;
  /** false until the first snapshot (or a queued create) arrived */
  ready: boolean;
  entries: TaskEntryView[];
  rows: OutboxRecord[];
  /** storagePath -> blobKey for photos still waiting in the outbox */
  pendingKeys: Map<string, string>;
  /** photo paths per queued entry (pending entries carry none themselves) */
  entryPaths: (e: TaskEntryView) => string[];
}

export function useTaskDetail(taskId: string): TaskDetailData {
  const source = useTasksSource();
  const projectId = useProjectId();
  const allRows = useOutboxRows(projectId);
  const [doc, setDoc] = useState<Task | null>(null);
  const [docSeen, setDocSeen] = useState(false);
  const [cloudEntries, setEntries] = useState<TaskEntry[]>([]);

  useEffect(() => {
    setDoc(null);
    setDocSeen(false);
    setEntries([]);
    if (!projectId) return;
    let u1 = () => {};
    let u2 = () => {};
    try {
      u1 = source.watchTask(projectId, taskId, (t) => {
        setDoc(t);
        setDocSeen(true);
      });
      u2 = source.watchTaskEntries(projectId, taskId, setEntries);
    } catch {
      setDocSeen(true);
    }
    return () => {
      u1();
      u2();
    };
  }, [source, projectId, taskId]);

  const rows = useMemo(
    () => allRows.filter((r) => (r.payload as { taskId?: string } | undefined)?.taskId === taskId),
    [allRows, taskId],
  );
  const task = useMemo(() => {
    const merged = mergeTaskViews(doc ? [doc as unknown as TaskView] : [], rows, {
      overlaySending: source.overlaySending,
    });
    return merged.find((t) => t.id === taskId) ?? null;
  }, [doc, rows, taskId, source.overlaySending]);
  const entries = useMemo(
    () => mergeTaskEntries(cloudEntries, rows, taskId, source.overlaySending),
    [cloudEntries, rows, taskId, source.overlaySending],
  );

  const { pendingKeys, byGuid } = useMemo(() => {
    const pk = new Map<string, string>();
    const bg = new Map<string, string[]>();
    for (const r of rows) {
      if (r.state === "sent" || r.state === "killed") continue;
      const p = r.payload as unknown as TaskActionPayload;
      const paths = (p.photoRefs ?? []).map((ref, i) => {
        const path = composePhotoPath(p.projectId, p.taskId, i, ref.sha256, ref.mime);
        pk.set(path, ref.blobKey);
        return path;
      });
      bg.set(p.clientGuid, paths);
    }
    return { pendingKeys: pk, byGuid: bg };
  }, [rows]);

  return {
    task,
    ready: docSeen || task !== null,
    entries,
    rows,
    pendingKeys,
    entryPaths: (e) => (e.pending ? (byGuid.get(e.clientGuid) ?? []) : (e.photos ?? []).map((p) => p.storagePath)),
  };
}

/** Actor + roster for assignee picker/stamps (demo roster or project members). */
export function useRoster(): { actor: TaskPerson; members: TaskPerson[] } {
  const db = useTasksFirestore();
  const projectId = useProjectId();
  // In cloud mode the hook loads the roster itself (null while loading or on failure).
  const { actor: hookActor, members } = useTaskPeople(db, projectId);
  const { user } = useAuth();
  const demo = isDemoAuth();
  const actor = useMemo(
    () => resolveActor({ demo, uid: user?.uid ?? hookActor.uid, email: user?.email, hookName: hookActor.name }),
    [demo, user?.uid, user?.email, hookActor.uid, hookActor.name],
  );
  return { actor, members: members ?? [] };
}

export function useBuildingNames(): Map<string, string> {
  const projectId = useProjectId();
  const list = useLiveQuery(() => (projectId ? listBuildings(projectId) : Promise.resolve([])), [projectId]);
  return useMemo(() => new Map((list ?? []).map((b) => [b.id, b.name])), [list]);
}

/** Drafts of the current project (live). */
export function useDrafts(): DraftSummary[] {
  const projectId = useProjectId();
  return (
    useLiveQuery(
      () => (projectId ? listDraftSummaries(draftTable, projectId) : Promise.resolve([])),
      [projectId],
    ) ?? []
  );
}

