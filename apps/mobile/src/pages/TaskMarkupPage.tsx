import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { isDemoAuth, useProjectId } from "@ff/auth";
import { effectiveTaskBuildingId, useTaskBuildingIndex, useTaskEngine, usePanelTasks } from "@ff/tasks-react";
import type { TaskStatus } from "@ff/tasks";
import { MarkupEditor } from "../markup/MarkupEditor";
import type { Flattened } from "../markup/inkRender";
import { renderPlanCapture } from "../markup/snapshot";
import { usePlanRecord } from "../plans/usePlans";
import { getTileService, useTileState } from "../plans/tileService";
import { getBlobStore } from "../storage";
import { useRoster, useTaskDetail } from "../tasks/hooks";
import { saveMarkup } from "../tasks/markupAttach";
import { planMarkup, type MarkupSource } from "../tasks/markupSource";
import { canComment } from "../tasks/transitions";
import type { TaskCaptureResult } from "../model/ModelView";
import "../tasks/tasks.css";
import "../markup/markupEditor.css";

const BuildingModel = lazy(() => import("./ModelPage").then((m) => ({ default: m.BuildingModel })));
/** A 3D capture that has not produced a frame by now is reported (the user can try again or cancel). */
const CAPTURE_TIMEOUT_MS = 150_000;

/**
 * `/tasks/:taskId/markup`: annotate a task. The page captures an HD picture of the task's location (the plan around its pin, or
 * the 3D view at its camera: the same framings as the location quick-access), opens the annotation editor on it, and on Accept
 * saves the flattened picture as an attachment of the task through the offline outbox. A task with both a plan pin and a 3D
 * location first asks which one. The 3D viewer is mounted only while the frame is taken and is gone when the editor opens.
 */
export function TaskMarkupPage() {
  const { taskId = "" } = useParams();
  const [search, setSearch] = useSearchParams();
  const navigate = useNavigate();
  const projectId = useProjectId();
  const engine = useTaskEngine();
  const { actor } = useRoster();
  const { task, ready } = useTaskDetail(taskId);
  const buildingIndex = useTaskBuildingIndex();
  const tasks = usePanelTasks();
  const [picture, setPicture] = useState<Blob | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const leave = useCallback(() => navigate(`/tasks/${encodeURIComponent(taskId)}`, { replace: true }), [navigate, taskId]);
  const loc = task?.location ?? null;
  const decision = useMemo(() => planMarkup(loc as never, search.get("src")), [loc, search]);

  const onPicture = useCallback((blob: Blob) => setPicture(blob), []);
  const onFail = useCallback((message: string) => setFailure(message), []);

  const accept = useCallback(
    async (flat: Flattened) => {
      if (!engine || !task || !projectId) throw new Error("The task engine is not ready.");
      await saveMarkup({ engine, projectId, taskId, title: task.title, statusFrom: task.status as TaskStatus, actor }, flat.blob);
      leave();
    },
    [engine, task, projectId, taskId, actor, leave],
  );

  if (!ready) return <Frame><p className="muted pad">Loading task...</p></Frame>;
  if (!task) {
    return (
      <Frame>
        <Notice testId="mk-no-task" title="This task is not on this device yet" body="It may not have synced, or it was removed." action={{ label: "Back to tasks", onClick: () => navigate("/tasks", { replace: true }) }} />
      </Frame>
    );
  }
  if (!canComment(task.status)) {
    return (
      <Frame>
        <Notice testId="mk-closed" title="This task is closed" body="Closed tasks accept no further changes, so a markup cannot be added." action={{ label: "Back to the task", onClick: leave }} />
      </Frame>
    );
  }
  if (picture) return <MarkupEditor image={picture} title={`Markup: ${task.title}`} onAccept={accept} onCancel={leave} />;
  if (decision.kind === "none") {
    return (
      <Frame>
        <Notice testId="mk-needs-location" title="A markup needs a location" body="Pin the task on a plan or in the 3D model first, then mark up the view of that place." action={{ label: "Back to the task", onClick: leave }} />
      </Frame>
    );
  }
  if (failure) {
    return (
      <Frame>
        <Notice
          testId="mk-capture-failed"
          title="Could not capture the view"
          body={failure}
          action={{ label: "Try again", onClick: () => { setFailure(null); setAttempt((n) => n + 1); } }}
          secondary={{ label: "Back to the task", onClick: leave }}
        />
      </Frame>
    );
  }
  if (decision.kind === "choose") {
    return (
      <Frame>
        <div className="mk-choose" data-testid="mk-choose">
          <h2>Mark up which view?</h2>
          <p className="muted">This task is pinned on a plan and in the 3D model.</p>
          <div className="mk-choose-row">
            {decision.sources.map((s) => (
              <button key={s} type="button" className="mk-choose-card" data-testid={`mk-choose-${s}`} onClick={() => setSearch({ src: s }, { replace: true })}>
                <strong>{s === "plan" ? "Plan" : "3D"}</strong>
                <span className="muted">{s === "plan" ? "The sheet around the task's pin" : "The model from the task's viewpoint"}</span>
              </button>
            ))}
          </div>
          <button type="button" className="btn" data-testid="mk-choose-cancel" onClick={leave}>
            Cancel
          </button>
        </div>
      </Frame>
    );
  }

  const source: MarkupSource = decision.source;
  if (source === "plan") {
    const pdf = (loc as { pdf: { pdfFileId: string; uv: [number, number] } }).pdf;
    return (
      <Frame>
        <PlanCaptureStage key={attempt} pdfFileId={pdf.pdfFileId} uv={pdf.uv} onPicture={onPicture} onFail={onFail} onCancel={leave} />
      </Frame>
    );
  }
  const buildingId = effectiveTaskBuildingId({ buildingId: task.buildingId, location: loc as never }, buildingIndex);
  if (!buildingId || !projectId) {
    return (
      <Frame>
        <Notice testId="mk-capture-failed" title="Could not capture the view" body="The building of this task is not known on this device." action={{ label: "Back to the task", onClick: leave }} />
      </Frame>
    );
  }
  return (
    <Capture3D key={attempt} projectId={projectId} buildingId={buildingId} taskId={taskId} tasks={tasks} onPicture={onPicture} onFail={onFail} onCancel={leave} />
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="mk-frame" data-testid="mk-frame">
      {children}
    </div>
  );
}

function Notice({ title, body, action, secondary, testId }: { title: string; body: string; action: { label: string; onClick(): void }; secondary?: { label: string; onClick(): void }; testId: string }) {
  return (
    <div className="mk-notice" data-testid={testId} role="alert">
      <h2>{title}</h2>
      <p className="muted">{body}</p>
      <div className="mk-notice-actions">
        {secondary && (
          <button type="button" className="btn" data-testid="mk-notice-secondary" onClick={secondary.onClick}>
            {secondary.label}
          </button>
        )}
        <button type="button" className="btn primary" data-testid="mk-notice-action" onClick={action.onClick}>
          {action.label}
        </button>
      </div>
    </div>
  );
}

/** Plan: composite the finest tiles around the pin (from the device, offline) into one HD picture. */
function PlanCaptureStage({ pdfFileId, uv, onPicture, onFail, onCancel }: { pdfFileId: string; uv: [number, number]; onPicture(b: Blob): void; onFail(m: string): void; onCancel(): void }) {
  const rec = usePlanRecord(pdfFileId);
  const version = rec?.version;
  const ref = rec?.ref ?? null;
  const state = useTileState(version?.id);
  const demo = isDemoAuth();
  const cbs = useRef({ onPicture, onFail });
  cbs.current = { onPicture, onFail };

  useEffect(() => {
    if (demo && ref && state.state === "none") void getTileService().ensureTiles(ref).catch(() => undefined);
  }, [demo, ref, state.state]);

  const manifest = state.state === "ready" || state.state === "partial" ? state.manifest : null;
  const versionId = manifest?.planVersionId;
  useEffect(() => {
    if (!manifest) return;
    let live = true;
    void renderPlanCapture({ manifest, store: getBlobStore(), uv })
      .then((r) => live && cbs.current.onPicture(r.blob))
      .catch((e) => live && cbs.current.onFail(`The plan picture could not be rendered: ${(e as Error).message}`));
    return () => {
      live = false;
    };
    // the manifest of one plan version is captured once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [versionId]);

  useEffect(() => {
    if (rec && (!rec.file || rec.notOffline || !version)) cbs.current.onFail(rec.file ? "This plan is not on the device yet. Make its building available offline first." : "This plan was not found.");
    else if (state.state === "error") cbs.current.onFail(`This plan could not be prepared: ${state.message}`);
  }, [rec, version, state]);

  return (
    <div className="mk-capturing" data-testid="mk-capturing" data-source="plan">
      <p>Capturing the plan around the pin...</p>
      {state.state === "rendering" && <p className="muted">Rendering plan for offline use... {state.progress.total ? Math.round((100 * state.progress.done) / state.progress.total) : 0}%</p>}
      <button type="button" className="btn" data-testid="mk-capture-cancel" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}

/** 3D: mount the ONE viewer at the task's view, take one HD frame, hand it up; the parent unmounts the viewer right after. */
function Capture3D({ projectId, buildingId, taskId, tasks, onPicture, onFail, onCancel }: { projectId: string; buildingId: string; taskId: string; tasks: ReturnType<typeof usePanelTasks>; onPicture(b: Blob): void; onFail(m: string): void; onCancel(): void }) {
  const cbs = useRef({ onPicture, onFail });
  cbs.current = { onPicture, onFail };
  const capture = useMemo(
    () => ({
      taskId,
      onResult: (r: TaskCaptureResult) => (r.ok ? cbs.current.onPicture(r.blob) : cbs.current.onFail(r.message)),
    }),
    [taskId],
  );
  useEffect(() => {
    const t = window.setTimeout(() => cbs.current.onFail("The 3D view took too long to get ready."), CAPTURE_TIMEOUT_MS);
    return () => window.clearTimeout(t);
  }, []);
  return (
    <div className="mk-capture3d" data-testid="mk-capture3d">
      <div className="model-page">
        <Suspense fallback={null}>
          <BuildingModel projectId={projectId} buildingId={buildingId} taskId={taskId} tasks={tasks} toolbarSlot={null} capture={capture} />
        </Suspense>
      </div>
      <div className="mk-cover" data-testid="mk-capturing" data-source="3d">
        <p>Taking an HD picture of the 3D view at the task's location...</p>
        <button type="button" className="btn" data-testid="mk-capture-cancel" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
