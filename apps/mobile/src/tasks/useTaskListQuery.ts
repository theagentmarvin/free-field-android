import { useDeferredValue, useMemo } from "react";
import {
  SAVED_VIEWS,
  minuteOf,
  selectTaskList,
  useTaskBuildingIndex,
  type TaskListResult,
  type TaskTableRow,
} from "@ff/tasks-react";
import type { TaskView } from "@ff/tasks";
import { useListStore } from "./listStore";

/**
 * The tablet's task list: the web's `selectTaskList` run over the merged rows, driven by the list store. No filter rule lives here.
 *
 * Perf: the inputs are the merged rows (one array per snapshot) and small store values; `selectTaskList` re-uses enriched row objects
 * per source task, so typing in search or toggling a filter allocates no new row objects, and the search text is deferred so a
 * keystroke never blocks on a 2,000-task pass.
 */
export function useTaskListQuery(
  tasks: readonly TaskView[],
  uid: string | null | undefined,
  buildingNames: ReadonlyMap<string, string>,
  firstBuildingId: string | null,
): TaskListResult {
  const { chip, search, sort, viewId, scope, scopeBuildingId, quick, columnFilters } = useListStore();
  const deferredSearch = useDeferredValue(search);
  const buildingIndex = useTaskBuildingIndex();
  const view = useMemo(() => SAVED_VIEWS.find((v) => v.id === viewId) ?? null, [viewId]);
  const now = Date.now();
  const minute = minuteOf(now);
  const buildingId = scopeBuildingId ?? firstBuildingId;
  return useMemo(
    () =>
      selectTaskList(tasks, {
        chip,
        search: deferredSearch,
        sort: sort === "title" ? "updated" : sort,
        columnSort: sort === "title" ? { colId: "title", dir: "asc" } : undefined,
        view,
        scope,
        buildingId,
        quick,
        columnFilters,
        uid,
        now,
        buildingIndex,
        buildingNames,
      }),
    // `now` is minute-granular on purpose (overdue / due-soon do not need a tighter clock)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tasks, chip, deferredSearch, sort, view, scope, buildingId, quick, columnFilters, uid, minute, buildingIndex, buildingNames],
  );
}

export type { TaskTableRow };
