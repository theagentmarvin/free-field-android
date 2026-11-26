import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { isDemoAuth, useAuth, useAuthContext, useProjectId } from "@ff/auth";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "@ff/data/db/database";
import { pickCalibrationScale } from "../measure/webMath";
import { planMeasureStore } from "../measure/planMeasureStore";
import { usePanelTasks } from "@ff/tasks-react";
import { getBlobStore } from "../storage";
import { usePlanRecord } from "../plans/usePlans";
import { getTileService, useTileState } from "../plans/tileService";
import { PlanViewer } from "../plans/PlanViewer";
import type { ViewHint } from "../plans/tileMath";
import { pinsForPlan } from "../plans/pins";
import { defaultComparePair, listRevisions, revisionPosition, revisionTitle } from "../plans/revisions";
import { RevisionSheet, useRevisionDownload } from "../plans/RevisionSheet";
import { newTaskUrl } from "../plans/anchor";
import { PlanLinkButton } from "../linkview/PlanLinkButton";

/**
 * Route `/plans/:pdfFileId`: the tile viewer for the plan's newest version on the device, or, with `?rev=<versionId>`,
 * an older revision, read-only and labelled ("Revision 1 of 2, not the latest") with a way back to the latest.
 * Tiles of the newest version are rendered when the plan is downloaded (see plans/tileSync.ts); opening it only
 * reads them. Older revisions and demo mode (no offline package) render on the spot, from the PDF on the device.
 */
export function PlanViewerPage() {
  const { pdfFileId = "" } = useParams();
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const revParam = search.get("rev");
  const rec = usePlanRecord(pdfFileId, revParam);
  const [sheetOpen, setSheetOpen] = useState(false);
  const file = rec?.file;
  const version = rec?.version;
  const ref = rec?.ref ?? null;
  const state = useTileState(version?.id);
  const openedAt = useRef(performance.now());
  const versionId = version?.id;
  const onViewHint = useCallback((h: ViewHint) => { if (versionId) getTileService().setViewHint(versionId, h); }, [versionId]);
  const tasks = usePanelTasks();
  const versions = rec?.versions;
  const isLatest = !!version && !!rec?.latest && version.id === rec.latest.id;
  const pins = useMemo(() => {
    if (!version) return [];
    const all = pinsForPlan(tasks, pdfFileId, version.id, 1, versions ?? []);
    // An older revision shows only the pins placed on it; the others belong to a drawing that came later.
    return isLatest ? all : all.filter((p) => !p.onEarlierRevision);
  }, [tasks, pdfFileId, version, versions, isLatest]);
  const revisions = useMemo(() => listRevisions(versions ?? [], rec?.onDevice ?? null), [versions, rec?.onDevice]);
  const position = version && versions ? revisionPosition(versions, version.id) : null;
  const hasHistory = (versions?.length ?? 0) > 1;
  const readOnly = !!version && !isLatest;
  const latestOnDevice = !rec?.onDevice || (!!rec.latest && rec.onDevice.has(rec.latest.id));
  const store = getBlobStore();
  const projectId = useProjectId();
  const { user } = useAuth();
  const { project } = useAuthContext();
  const measureStore = useMemo(() => planMeasureStore(user?.uid ?? ""), [user?.uid]);
  // The scale of this plan's calibration (metres per page unit), like the web: the newest valid row of the project for this file.
  const calibrationMpu = useLiveQuery(async () => pickCalibrationScale(await db.calibrations.where("pdfFileId").equals(pdfFileId).toArray(), projectId), [pdfFileId, projectId], null);

  // Cloud mode never renders on open: the download hook (or the start-up reconcile) did it. Demo mode
  // has no download step, so a plan without tiles is rendered here.
  const demo = isDemoAuth();
  // Older revisions are tiled on demand in cloud mode too (their PDF is on the device, only the tiles are lazy).
  const renderOnOpen = demo || readOnly;
  useEffect(() => {
    if (renderOnOpen && ref && state.state === "none") void getTileService().ensureTiles(ref).catch(() => undefined);
  }, [renderOnOpen, ref, state.state]);

  const goRevision = useCallback(
    (versionId: string) => {
      setSheetOpen(false);
      navigate(rec?.latest?.id === versionId ? `/plans/${pdfFileId}` : `/plans/${pdfFileId}?rev=${versionId}`, { replace: false });
    },
    [navigate, pdfFileId, rec?.latest?.id],
  );
  const goCompare = useCallback(() => {
    const pair = defaultComparePair(revisions, version?.id);
    if (pair) navigate(`/plans/${pdfFileId}/compare?base=${pair.base}&rev=${pair.revision}`);
  }, [navigate, pdfFileId, revisions, version?.id]);
  const download = useRevisionDownload(project?.id ?? null, file?.buildingId);

  const back = (
    <Link to="/plans" className="back" data-testid="plan-back">
      ‹ Plans
    </Link>
  );
  if (rec === undefined) return <p className="muted pad">Loading…</p>;
  if (file && rec?.notOffline)
    return (
      <div>
        {back}
        <p className="muted pad" data-testid="plan-not-offline">
          This plan is not on the device yet. Make its building available offline from <Link to="/offline">Offline buildings</Link>.
        </p>
      </div>
    );
  if (file && rec.revisionMissing)
    return (
      <div className="plan-page" data-testid="plan-page" data-plan-name={file.name}>
        <div className="plan-bar">
          {back}
          <strong className="grow">{file.name}</strong>
        </div>
        <div className="center-screen" data-testid="revision-missing">
          <p>Revision {rec.revisionMissing.versionNumber} of this plan is not on the device yet.</p>
          <p className="muted">{download.online ? "Download it to open it, also without a connection later." : "You are offline. Connect to download it."}</p>
          {download.notice && <p className="error">{download.notice}</p>}
          <div className="row" style={{ justifyContent: "center" }}>
            <button type="button" className="btn primary" data-testid="revision-download" disabled={download.busy || !download.online} onClick={() => void download.download()}>
              Download revision {rec.revisionMissing.versionNumber}
            </button>
            <button type="button" className="btn" data-testid="revision-open-latest" onClick={() => navigate(`/plans/${pdfFileId}`)}>
              Open the latest
            </button>
          </div>
        </div>
      </div>
    );
  if (!file || !version || !ref)
    return (
      <div>
        {back}
        <p className="muted pad">Plan not found.</p>
      </div>
    );

  // While a render is running the viewer already opens on the preview and the tiles written so far.
  const manifest = state.state === "ready" || state.state === "partial" || state.state === "rendering" ? (state.manifest ?? null) : null;
  const rendering = state.state === "rendering" && manifest ? state.progress : null;
  return (
    <div className="plan-page" data-testid="plan-page" data-plan-name={file.name} data-revision-number={version.versionNumber} data-revision-latest={isLatest ? "1" : "0"}>
      <div className="plan-bar">
        {back}
        <strong className="grow">{file.name}</strong>
        {state.state === "partial" && <span className="tile-badge warn">Partly rendered</span>}
        {rendering && (
          <span className="tile-badge warn" data-testid="plan-rendering">
            Sharpening… {rendering.total ? Math.round((100 * rendering.done) / rendering.total) : 0}%
          </span>
        )}
        {isLatest && projectId && <PlanLinkButton projectId={projectId} pdfFileId={pdfFileId} />}
        {hasHistory && (
          <button type="button" className="btn small" data-testid="plan-revisions" onClick={() => setSheetOpen(true)}>
            Revisions
          </button>
        )}
      </div>
      {readOnly && position && (
        <div className="rev-banner" data-testid="revision-banner" role="status">
          <span className="grow">
            <strong>{revisionTitle(position)}</strong> · read-only
            {!latestOnDevice && <span className="muted"> · the latest is not on this device yet (Revisions)</span>}
          </span>
          <button type="button" className="btn small primary" data-testid="revision-open-latest" disabled={!latestOnDevice} onClick={() => rec?.latest && goRevision(rec.latest.id)}>
            Back to latest
          </button>
          <button type="button" className="btn small" data-testid="revision-banner-compare" disabled={!defaultComparePair(revisions, version.id)} onClick={goCompare}>
            Compare
          </button>
        </div>
      )}
      {manifest ? (
        <PlanViewer
          manifest={manifest}
          store={store}
          renderTick={rendering ? rendering.done : undefined}
          onViewHint={rendering ? onViewHint : undefined}
          openedAt={openedAt.current}
          pins={pins}
          readOnly={readOnly}
          revisionNumber={version.versionNumber}
          onViewRevision={goRevision}
          measure={{ store: measureStore, calibrationMpu: calibrationMpu ?? null }}
          onPinTap={(p) => navigate(`/tasks/${p.taskId}`)}
          onNewTask={(uv) => navigate(newTaskUrl({ pdfFileId, planVersionId: version.id, page: 1, uv }))}
        />
      ) : (
        <div className="center-screen" data-testid="plan-preparing">
          {state.state === "rendering" ? (
            <p>Rendering plan for offline use… {state.progress.total ? Math.round((100 * state.progress.done) / state.progress.total) : 0}%</p>
          ) : state.state === "error" ? (
            <>
              <p className="error">Could not prepare this plan: {state.message}</p>
              <button type="button" className="btn primary" onClick={() => void getTileService().ensureTiles(ref).catch(() => undefined)}>
                Retry
              </button>
            </>
          ) : (
            <>
              <p className="muted" data-testid="plan-no-tiles">
                {demo ? "Preparing…" : "The tiles of this plan are not rendered yet."}
              </p>
              {!demo && (
                <button type="button" className="btn primary" data-testid="plan-render-now" onClick={() => void getTileService().ensureTiles(ref).catch(() => undefined)}>
                  Render now
                </button>
              )}
            </>
          )}
        </div>
      )}
      {sheetOpen && (
        <RevisionSheet
          projectId={project?.id ?? null}
          buildingId={file.buildingId}
          revisions={revisions}
          current={version.id}
          onOpen={goRevision}
          onCompare={() => {
            setSheetOpen(false);
            goCompare();
          }}
          onClose={() => setSheetOpen(false)}
        />
      )}
    </div>
  );
}
