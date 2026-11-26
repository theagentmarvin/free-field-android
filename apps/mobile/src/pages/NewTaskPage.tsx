import { initCaptureRecovery } from "../tasks/camera";
import { TaskForm } from "../tasks/Form";
import { useLocation } from "react-router-dom";
import "../tasks/tasks.css";

initCaptureRecovery();

/**
 * `/tasks/new`: the dedicated New task screen, the one place every entry point lands (Tasks tab, Drafts folder, plan and 3D
 * long-press, "Create task from markup"). It renders the form alone: never the task list, in either orientation. The key makes a
 * different pin or draft start a fresh form.
 */
export function NewTaskPage() {
  const { search } = useLocation();
  return <TaskForm key={`new${search}`} mode="create" />;
}
