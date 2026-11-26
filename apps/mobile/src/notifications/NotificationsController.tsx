import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth, useAuthContext, useProjectId, useProjectSelection } from "@ff/auth";
import type { Task } from "@ff/firestore";
import { useTasksSource } from "@ff/tasks-react";
import { useRoster } from "../tasks/hooks";
import { TASK_PAGE } from "../tasks/paging";
import "./notifications.css";
import { NotifyEngine } from "./engine";
import { localNotifier, onNotificationTap, type NotificationTap } from "./platform";
import { NOT_MEMBER_MESSAGE, resolveTap } from "./tapRoute";
import { getSettings, localKV, useNotifySettings } from "./settings";

/**
 * Mounted once per signed-in project. Watches the newest window of the project's tasks (the same source the Tasks tab reads, so the
 * cloud listener or the demo store) and hands every snapshot to the engine; routes notification taps to the task.
 */
export function NotificationsController() {
  const source = useTasksSource();
  const projectId = useProjectId();
  const { user } = useAuth();
  const { project } = useAuthContext();
  const { actor } = useRoster();
  const navigate = useNavigate();
  const { currentProjectId, memberships, setCurrentProject } = useProjectSelection();
  const [pendingTap, setPendingTap] = useState<NotificationTap | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const settings = useNotifySettings();
  const last = useRef<Task[] | null>(null);
  const engineRef = useRef<NotifyEngine | null>(null);

  const uid = user?.uid ?? null;
  const name = actor.name || user?.email || uid || "";
  const projectName = project?.name ?? projectId ?? "project";

  const engine = useMemo(() => {
    if (!uid || !projectId) return null;
    return new NotifyEngine({
      me: { uid, name },
      projectId,
      projectName,
      kv: localKV(),
      notifier: localNotifier,
      settings: getSettings,
      watchEntries: (taskId, cb) => source.watchTaskEntries(projectId, taskId, cb),
      now: () => Date.now(),
    });
  }, [uid, name, projectId, projectName, source]);

  useEffect(() => {
    engineRef.current = engine;
    last.current = null;
    if (!engine || !projectId) return;
    let unsub = () => {};
    try {
      unsub = source.watchTasks(
        projectId,
        null,
        (tasks) => {
          last.current = tasks;
          void engine.onTasks(tasks).catch((err) => console.warn("[notify] snapshot failed", err));
        },
        TASK_PAGE,
      );
    } catch {
      /* no backend reachable: nothing to watch */
    }
    return () => {
      unsub();
      engine.dispose();
    };
  }, [engine, source, projectId]);

  // A preference changed (master, deadlines on again, permission just granted): re-plan the deadline alarms on the last snapshot.
  useEffect(() => {
    const tasks = last.current;
    if (engineRef.current && tasks) void engineRef.current.onTasks(tasks).catch(() => undefined);
  }, [settings]);

  // Tapping a notification opens its task (or the list for a summary), in the project it was raised for: another current
  // project is switched away from first (membership checked), and a tap that arrives before memberships load is held.
  useEffect(() => onNotificationTap(setPendingTap), []);
  useEffect(() => {
    if (!pendingTap) return;
    const route = resolveTap(pendingTap, currentProjectId, memberships);
    if (route.kind === "wait") return;
    if (route.kind === "switch") {
      if (setCurrentProject(route.projectId)) return; // re-runs once the new project is current, then opens
      setNotice(NOT_MEMBER_MESSAGE);
    } else if (route.kind === "not-member") {
      setNotice(NOT_MEMBER_MESSAGE);
    } else {
      navigate(route.path);
    }
    setPendingTap(null);
  }, [pendingTap, currentProjectId, memberships, setCurrentProject, navigate]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(t);
  }, [notice]);

  return notice ? (
    <div className="notify-notice" role="status" data-testid="notify-notice" onClick={() => setNotice(null)}>
      {notice}
    </div>
  ) : null;
}
