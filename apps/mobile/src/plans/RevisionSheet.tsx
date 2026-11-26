import { useState } from "react";
import { isDemoAuth } from "@ff/auth";
import { useNetworkStatus } from "../platform/network";
import { getDownloadManager } from "../offline/instance";
import { OfflineRefusal } from "../offline/types";
import { useOfflineState } from "../offline/useOffline";
import { formatRevisionDate, type RevisionInfo } from "./revisions";

export interface RevisionSheetProps {
  projectId: string | null;
  buildingId: string | undefined;
  revisions: RevisionInfo[];
  /** The revision on screen. */
  current: string;
  onOpen: (versionId: string) => void;
  onCompare: () => void;
  onClose: () => void;
}

/** Why a revision cannot be opened right now (shared by the sheet and the "not on this device" screen). */
export function useRevisionDownload(projectId: string | null, buildingId: string | undefined) {
  const net = useNetworkStatus();
  const state = useOfflineState(projectId);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pkg = buildingId ? state?.get(buildingId) : undefined;
  const statusOf = (versionId: string) => pkg?.items.find((i) => i.versionId === versionId && i.kind === "pdf")?.status;
  const download = async () => {
    if (!projectId || !buildingId) return;
    setNotice(null);
    if (!net.online) {
      setNotice("You are offline. Connect to download this revision; it is saved on the device afterwards.");
      return;
    }
    setBusy(true);
    try {
      await getDownloadManager().start(buildingId, projectId);
    } catch (e) {
      setNotice(e instanceof OfflineRefusal || e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return { online: net.online, notice, busy, statusOf, download };
}

/** Revision history of one plan: every version with number, name and date; open one read-only, download or compare. */
export function RevisionSheet({ projectId, buildingId, revisions, current, onOpen, onCompare, onClose }: RevisionSheetProps) {
  const dl = useRevisionDownload(projectId, buildingId);
  const usable = revisions.filter((r) => r.onDevice).length;
  const missing = revisions.some((r) => !r.onDevice);
  return (
    <div className="rev-sheet" data-nogesture data-testid="revision-sheet" role="dialog" aria-label="Revision history">
      <div className="rev-sheet-head">
        <strong className="grow">Revisions</strong>
        <button type="button" className="btn" data-testid="revision-close" onClick={onClose}>
          Close
        </button>
      </div>
      <ul className="list rev-list">
        {revisions.map((r) => {
          const st = dl.statusOf(r.versionId);
          return (
            <li key={r.versionId} className={`rev-row${r.versionId === current ? " is-current" : ""}`} data-testid="revision-row" data-version-id={r.versionId} data-version-number={r.number} data-on-device={r.onDevice ? "1" : "0"}>
              <div className="grow">
                <div className="rev-title">
                  Revision {r.number}
                  {r.isLatest && <span className="tile-badge ok">Latest</span>}
                  {r.versionId === current && <span className="tile-badge">Viewing</span>}
                </div>
                <div className="muted rev-meta">
                  {r.name}
                  {r.storedAt ? ` · ${formatRevisionDate(r.storedAt)}` : ""}
                </div>
                {!r.onDevice && (
                  <div className="rev-meta" data-testid="revision-not-on-device">
                    {st === "downloading" || st === "verifying" || st === "queued" ? "Downloading…" : dl.online ? "Not on this device yet" : "Not on this device. Connect to download it."}
                  </div>
                )}
              </div>
              {r.onDevice ? (
                r.versionId !== current && (
                  <button type="button" className="btn" data-testid="revision-open" onClick={() => onOpen(r.versionId)}>
                    Open
                  </button>
                )
              ) : (
                !isDemoAuth() && (
                  <button type="button" className="btn" data-testid="revision-download" disabled={dl.busy || st === "downloading" || st === "verifying"} onClick={() => void dl.download()}>
                    Download
                  </button>
                )
              )}
            </li>
          );
        })}
      </ul>
      {dl.notice && (
        <p className="error rev-notice" data-testid="revision-notice">
          {dl.notice}
        </p>
      )}
      <div className="rev-sheet-foot">
        <button type="button" className="btn primary" data-testid="revision-compare" disabled={usable < 2} onClick={onCompare}>
          Compare revisions
        </button>
        {usable < 2 && <span className="muted rev-meta">{revisions.length < 2 ? "This plan has one revision." : missing ? "Download another revision to compare." : ""}</span>}
      </div>
    </div>
  );
}
