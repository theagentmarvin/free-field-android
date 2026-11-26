import { isStorageFull } from "../tasks/camera";
import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "@ff/data/db/database";
import { useAuthContext } from "@ff/auth";
import { useNetworkStatus } from "../platform/network";
import { getDownloadManager } from "../offline/instance";
import { fmt, isWifi } from "../offline/manager";
import { readSettings, writeSettings } from "../offline/settings";
import { OfflineRefusal, type PackageState } from "../offline/types";
import { useOfflineState } from "../offline/useOffline";
import { useTileState } from "../plans/tileService";

/** Shown instead of the raw filesystem / IndexedDB error when the device ran out of space (BUG-12). */
const OFFLINE_LOW_STORAGE =
  "The device is out of storage. Free some space (delete unused files or apps), then tap Retry. Nothing already downloaded is lost.";

const LABEL: Record<PackageState | "none", string> = {
  none: "Not offline",
  downloading: "Downloading",
  paused: "Paused",
  error: "Failed",
  ready: "Available offline",
  "update-available": "Update available",
};

/** Per-building offline packages: estimate, start/pause/resume/cancel/retry/remove, progress and badges. */
export function OfflinePage() {
  const { project } = useAuthContext();
  const projectId = project?.id ?? null;
  const net = useNetworkStatus();
  const state = useOfflineState(projectId);
  const [settings, setSettings] = useState(readSettings());
  const [notice, setNotice] = useState<string | null>(null);
  const manager = getDownloadManager();

  const buildings = useLiveQuery(() => (projectId ? db.buildings.where("projectId").equals(projectId).sortBy("name") : []), [projectId]);
  const estimates = useLiveQuery(async () => {
    const m = new Map<string, { items: number; remainingBytes: number; bytes: number }>();
    for (const b of buildings ?? []) m.set(b.id, await getDownloadManager().estimate(b.id));
    return m;
  }, [buildings]);

  const run = (fn: () => Promise<void>) => {
    setNotice(null);
    fn().catch((e) => setNotice(isStorageFull(e) ? OFFLINE_LOW_STORAGE : e instanceof OfflineRefusal || e instanceof Error ? e.message : String(e)));
  };
  const toggle = (patch: Partial<typeof settings>) => setSettings(writeSettings(patch));

  return (
    <section className="pad" data-testid="offline-page">
      <h2>Offline buildings</h2>
      <p className="muted" data-testid="offline-net">
        {net.online ? `Online (${net.connectionType})` : "Offline"}
      </p>
      <ul className="list">
        <li className="row">
          <label>
            <input type="checkbox" data-testid="wifi-only" checked={settings.wifiOnly} onChange={(e) => toggle({ wifiOnly: e.target.checked })} /> Download on Wi-Fi only
          </label>
        </li>
        <li className="row">
          <label>
            <input type="checkbox" data-testid="auto-update" checked={settings.autoUpdate} onChange={(e) => toggle({ autoUpdate: e.target.checked })} /> Update automatically on Wi-Fi
          </label>
        </li>
      </ul>
      {!net.online ? (
        <p className="muted" role="status" data-testid="offline-wait">
          Waiting for a network connection. Downloads continue automatically when you are back online.
        </p>
      ) : settings.wifiOnly && !isWifi(net) ? (
        <p className="muted" role="status" data-testid="offline-wait">
          Waiting for Wi-Fi. Downloads are paused because &quot;Download on Wi-Fi only&quot; is on and this device is on {net.connectionType === "unknown" ? "an unknown connection" : net.connectionType}. Connect to Wi-Fi, or turn the setting off to download now.
        </p>
      ) : null}
      {notice && (
        <p className="error" role="alert" data-testid="offline-refusal">
          {notice}
        </p>
      )}
      {buildings === undefined ? (
        <p className="muted">Loading…</p>
      ) : buildings.length === 0 ? (
        <p className="muted" data-testid="offline-empty">No buildings in this project yet.</p>
      ) : (
        <ul className="list" data-testid="offline-buildings">
          {buildings.map((b) => {
            const view = state?.get(b.id);
            const s = view?.summary;
            const st: PackageState | "none" = s?.state ?? "none";
            const est = estimates?.get(b.id);
            const active = st === "downloading";
            return (
              <li key={b.id} className="row col" data-testid={`offline-building-${b.id}`}>
                <div className="between">
                  <strong>{b.name}</strong>
                  <span className={`badge badge-${st}`} data-testid={`offline-badge-${b.id}`} data-state={st}>
                    {st === "paused" && view?.pkg?.pausedBy === "network" ? (net.online ? "Waiting for Wi-Fi" : "Waiting for network") : LABEL[st]}
                  </span>
                </div>
                {est && st === "none" && (
                  <span className="muted" data-testid={`offline-estimate-${b.id}`} data-bytes={est.remainingBytes}>
                    {est.items === 0 ? "Nothing to download yet" : `${est.items} file(s), about ${fmt(est.remainingBytes)}`}
                  </span>
                )}
                {s && s.totalItems > 0 && (
                  <>
                    <progress value={s.doneBytes} max={s.totalBytes || 1} data-testid={`offline-progress-${b.id}`} />
                    <span className="muted" data-testid={`offline-progress-text-${b.id}`} data-fraction={s.fraction.toFixed(3)}>
                      {fmt(s.doneBytes)} of {fmt(s.totalBytes)} ({s.doneItems}/{s.totalItems} files)
                    </span>
                    <ul className="list">
                      {view!.items.map((i) => (
                        <li key={i.id} data-testid={`offline-item-${i.id}`} data-status={i.status} className="muted">
                          {i.kind === "frag" ? "Model" : "Plan"} {i.fileName} v{i.versionNumber}: {i.status}
                          {i.status === "downloading" ? ` ${Math.round((i.bytesDone / Math.max(1, i.size)) * 100)}%` : ""}
                          {i.error ? <span className="error" data-testid={`offline-error-${i.id}`}> {isStorageFull(i.error) ? OFFLINE_LOW_STORAGE : i.error}</span> : null}
                          {i.kind === "pdf" && i.status === "done" && <PlanTileLine versionId={i.versionId} older={view!.items.some((x) => x.kind === "pdf" && x.fileId === i.fileId && x.versionNumber > i.versionNumber)} />}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                <div className="actions">
                  {(st === "none" || st === "update-available") && (
                    <button className="btn small" data-testid={`offline-start-${b.id}`} disabled={!est || est.items === 0} onClick={() => run(() => manager.start(b.id, b.projectId))}>
                      {st === "none" ? "Make available offline" : "Update now"}
                    </button>
                  )}
                  {active && (
                    <button className="btn small" data-testid={`offline-pause-${b.id}`} onClick={() => run(() => manager.pause(b.id))}>Pause</button>
                  )}
                  {st === "paused" && (
                    <button className="btn small" data-testid={`offline-resume-${b.id}`} onClick={() => run(() => manager.resume(b.id))}>Resume</button>
                  )}
                  {st === "error" && (
                    <button className="btn small" data-testid={`offline-retry-${b.id}`} onClick={() => run(() => manager.retryFailed(b.id))}>Retry failed</button>
                  )}
                  {(active || st === "paused" || st === "error") && (
                    <button className="btn small" data-testid={`offline-cancel-${b.id}`} onClick={() => run(() => manager.cancel(b.id))}>Cancel</button>
                  )}
                  {view && st !== "downloading" && (
                    <button className="btn small" data-testid={`offline-remove-${b.id}`} onClick={() => run(() => manager.remove(b.id))}>Remove offline copy</button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** Tile pre-rendering of a downloaded plan version: shown under the file line in the package list. */
function PlanTileLine({ versionId, older }: { versionId: string; older: boolean }) {
  const t = useTileState(versionId);
  let text = "tiles: checking";
  if (t.state === "rendering") text = `tiles: rendering ${t.progress.total ? Math.round((100 * t.progress.done) / t.progress.total) : 0}%`;
  else if (t.state === "ready") text = "tiles: ready";
  else if (t.state === "partial") text = "tiles: partly rendered";
  else if (t.state === "none") text = older ? "older revision: tiles are prepared when it is opened" : "tiles: waiting to render";
  else if (t.state === "error") text = `tiles: failed (${t.message})`;
  return (
    <span data-testid={`offline-tiles-${versionId}`} data-tile-state={t.state}>
      {" "}
      ({text})
    </span>
  );
}
