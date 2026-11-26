import { useEffect, useMemo } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "@ff/auth";
import { initCaptureRecovery, peekRecoveredCapture } from "../tasks/camera";
import { useBuildingNames, useDrafts, useTaskList } from "../tasks/hooks";
import { TaskDetail } from "../tasks/Detail";
import { TaskForm } from "../tasks/Form";
import { useListStore } from "../tasks/listStore";
import { useTaskListQuery } from "../tasks/useTaskListQuery";
import { ListPane } from "../tasks/ListPane";
import { useIsTablet } from "../platform/useBreakpoint";
import "../tasks/tasks.css";

// Register early: an activity restore after a camera launch fires at startup.
initCaptureRecovery();

/**
 * Tasks tab. Routes (see docs/ROUTES.md): `/tasks`, `/tasks/:taskId`, `/tasks/:taskId/edit`. Tablet: list + pane split; phone:
 * one screen at a time.
 */
export function TasksPage() {
  const { taskId } = useParams();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const tablet = useIsTablet();
  const { user } = useAuth();
  const { tasks, loaded, hasMore, loadMore } = useTaskList();
  const drafts = useDrafts();
  const buildingNames = useBuildingNames();
  const showDrafts = useListStore((st) => st.showDrafts);

  const isEdit = !!taskId && pathname.endsWith("/edit");

  const buildings = useMemo(() => [...buildingNames].map(([id, name]) => ({ id, name })), [buildingNames]);
  const firstBuildingId = buildings[0]?.id ?? null;
  const result = useTaskListQuery(tasks, user?.uid, buildingNames, firstBuildingId);
  const visible = result.rows;

  // A camera capture parked by an activity restore re-opens its draft.
  useEffect(() => {
    void peekRecoveredCapture().then((rec) => {
      if (rec) navigate(`/tasks/new?draft=${encodeURIComponent(rec.draftId)}`, { replace: true });
    });
  }, [navigate]);

  const selectedId = taskId ?? (tablet && !showDrafts ? visible[0]?.id : undefined);
  const list = (
    <ListPane
      tasks={tasks}
      loaded={loaded}
      hasMore={hasMore}
      onLoadMore={loadMore}
      drafts={drafts}
      buildings={buildings}
      firstBuildingId={firstBuildingId}
      selectedId={selectedId}
      list={result}
    />
  );

  let detail: JSX.Element | null = null;
  if (isEdit && taskId) detail = <TaskForm key={`edit${taskId}`} mode="edit" taskId={taskId} />;
  else if (selectedId) detail = <TaskDetail key={selectedId} taskId={selectedId} onBack={tablet ? undefined : () => navigate("/tasks")} />;

  if (tablet) {
    return (
      <div className="split" data-testid="tasks-split">
        <div className="pane list-pane">{list}</div>
        <div className="pane detail-pane">
          {detail ?? (
            <div className="empty">
              <p className="muted">Select a task, or</p>
              <Link to="/tasks/new" className="btn primary">
                Create a task
              </Link>
            </div>
          )}
        </div>
      </div>
    );
  }
  if (taskId) {
    return (
      <div className="phone-detail">
        {isEdit && (
          <button type="button" className="back" onClick={() => navigate(`/tasks/${taskId}`)} data-testid="task-back">
            &lsaquo; Task
          </button>
        )}
        {detail}
      </div>
    );
  }
  return list;
}
