import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { useEffect } from "react";
import { isDemoAuth, useProjectSelection } from "@ff/auth";
import { AppShell } from "./shell/AppShell";
import { SignInPage } from "./pages/SignInPage";
import { ProjectPickerPage } from "./pages/ProjectPickerPage";
import { PlansPage } from "./pages/PlansPage";
import { PlanComparePage } from "./pages/PlanComparePage";
import { PlanViewerPage } from "./pages/PlanViewerPage";
import { TasksPage } from "./pages/TasksPage";
import { NewTaskPage } from "./pages/NewTaskPage";
import { TaskMarkupPage } from "./pages/TaskMarkupPage";
import { SyncPage } from "./pages/SyncPage";
import { MorePage } from "./pages/MorePage";
import { OfflinePage } from "./pages/OfflinePage";
import { OfflineController } from "./offline/OfflineController";
import { PlanTilesController } from "./plans/PlanTilesController";
import { useSession } from "./auth/useSession";
import { AuthLinkHandler } from "./auth/AuthLinkHandler";
import { testHooksEnabled } from "./dev/flag";
import { SyncController } from "./sync/SyncController";
import { BackButtonController } from "./platform/BackButtonController";
import { NotificationsController } from "./notifications/NotificationsController";
import { ReachabilityController } from "./sync/ReachabilityController";
import { markProjectOpened } from "./projects/openedProjects";
// The viewer (three + OBC + fragments) is the bulk of the bundle: load it on demand.
// e2e-only seam: dead code (and its chunk) in release builds.
const TestHooks = testHooksEnabled()
  ? lazy(() => import("./dev/TestHooks").then((m) => ({ default: m.TestHooks })))
  : null;
const LinkviewPage = lazy(() => import("./linkview/LinkviewPage").then((m) => ({ default: m.LinkviewPage })));
const ModelPage = lazy(() => import("./pages/ModelPage").then((m) => ({ default: m.ModelPage })));
import { useDemoSeed } from "./seed/useDemoSeed";

export function App() {
  const session = useSession();
  const { currentProjectId } = useProjectSelection();
  const seed = useDemoSeed();
  const demo = isDemoAuth();

  // Remember which projects were opened on this device (offline availability).
  useEffect(() => {
    if (session.uid && currentProjectId) markProjectOpened(window.localStorage, session.uid, currentProjectId);
  }, [session.uid, currentProjectId]);

  if (session.status === "loading") {
    return <p className="muted pad" data-testid="auth-loading">Loading…</p>;
  }
  if (session.status === "signed-out") {
    return (
      <>
        {!demo && <AuthLinkHandler />}
        <Routes>
          <Route path="*" element={<SignInPage />} />
        </Routes>
      </>
    );
  }
  if (!currentProjectId) {
    return (
      <Routes>
        <Route path="*" element={<ProjectPickerPage />} />
      </Routes>
    );
  }
  return (
    <>
      <BackButtonController />
      <SyncController />
      <ReachabilityController />
      <NotificationsController />
      <PlanTilesController />
      <OfflineController />
      {TestHooks && (
        <Suspense fallback={null}>
          <TestHooks />
        </Suspense>
      )}
      <Routes>
        <Route element={<AppShell seedReady={!demo || seed.ready} />}>
          <Route path="/plans" element={<PlansPage />} />
          <Route path="/plans/:pdfFileId" element={<PlanViewerPage />} />
          <Route path="/plans/:pdfFileId/compare" element={<PlanComparePage />} />
          {["/model", "/model/:buildingId"].map((path) => (
            <Route
              key={path}
              path={path}
              element={
                <Suspense fallback={<p className="muted pad">Loading viewer…</p>}>
                  <ModelPage />
                </Suspense>
              }
            />
          ))}
          <Route
            path="/linkview/:buildingId"
            element={
              <Suspense fallback={<p className="muted pad">Loading viewer…</p>}>
                <LinkviewPage />
              </Suspense>
            }
          />
          <Route path="/tasks" element={<TasksPage />} />
          <Route path="/tasks/new" element={<NewTaskPage />} />
          <Route path="/tasks/:taskId" element={<TasksPage />} />
          <Route path="/tasks/:taskId/edit" element={<TasksPage />} />
          <Route path="/tasks/:taskId/markup" element={<TaskMarkupPage />} />
          <Route path="/sync" element={<SyncPage />} />
          <Route path="/more" element={<MorePage />} />
          <Route path="/offline" element={<OfflinePage />} />
          <Route path="*" element={<Navigate to="/tasks" replace />} />
        </Route>
      </Routes>
    </>
  );
}
