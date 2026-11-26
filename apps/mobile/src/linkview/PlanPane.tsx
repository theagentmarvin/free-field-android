import { useCallback, useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { isDemoAuth } from "@ff/auth";
import { getBlobStore } from "../storage";
import { getTileService, useTileState } from "../plans/tileService";
import { PlanViewer } from "../plans/PlanViewer";
import type { PlanPin } from "../plans/pins";
import type { ViewHint } from "../plans/tileMath";
import type { PlanManifest } from "../plans/manifest";
import type { PlanRecord } from "../plans/usePlans";
import type { PagePt, PlanMarker } from "./sync";

interface Props {
  rec: PlanRecord | undefined;
  pins: PlanPin[];
  marker: PlanMarker | null;
  onPlace: (p: PagePt) => void;
  onTurn: (heading: number) => void;
  onPinTap: (taskId: string) => void;
  onNewTask: (versionId: string, uv: [number, number]) => void;
  onManifest: (m: PlanManifest | null) => void;
}

/** The plan side of the Link view: the existing tile viewer (pinch / pan / pins / long press) with the camera marker on top. */
export function PlanPane({ rec, pins, marker, onPlace, onTurn, onPinTap, onNewTask, onManifest }: Props) {
  const version = rec?.version;
  const ref = rec?.ref ?? null;
  const state = useTileState(version?.id);
  const demo = isDemoAuth();
  // While a render is running the viewer already opens on the preview and the tiles written so far.
  const manifest = state.state === "ready" || state.state === "partial" || state.state === "rendering" ? (state.manifest ?? null) : null;
  const rendering = state.state === "rendering" && manifest ? state.progress : null;
  const openedAt = useRef(performance.now());
  const versionId = version?.id;
  const onViewHint = useCallback((h: ViewHint) => { if (versionId) getTileService().setViewHint(versionId, h); }, [versionId]);
  useEffect(() => {
    if (demo && ref && state.state === "none") void getTileService().ensureTiles(ref).catch(() => undefined);
  }, [demo, ref, state.state]);
  useEffect(() => {
    onManifest(manifest);
  }, [manifest, onManifest]);

  if (rec === undefined) return <p className="muted pad">Loading…</p>;
  if (rec.file && rec.notOffline)
    return (
      <div className="center-screen" data-testid="lv-plan-not-offline">
        <p>This plan is not on the device yet.</p>
        <Link to="/offline" className="btn primary">
          Make available offline
        </Link>
      </div>
    );
  if (!rec.file || !version || !ref) return <p className="muted pad">Plan not found.</p>;
  if (!manifest)
    return (
      <div className="center-screen" data-testid="lv-plan-preparing">
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
            <p className="muted">{demo ? "Preparing…" : "The tiles of this plan are not rendered yet."}</p>
            {!demo && (
              <button type="button" className="btn primary" data-testid="lv-plan-render" onClick={() => void getTileService().ensureTiles(ref).catch(() => undefined)}>
                Render now
              </button>
            )}
          </>
        )}
      </div>
    );
  return <PlanViewer key={manifest.planVersionId} manifest={manifest} store={getBlobStore()} renderTick={rendering ? rendering.done : undefined} onViewHint={rendering ? onViewHint : undefined} openedAt={openedAt.current} pins={pins} onPinTap={(p) => onPinTap(p.taskId)} onNewTask={(uv) => onNewTask(version.id, uv)} linkview={{ marker, onPlace, onTurn }} />;
}
