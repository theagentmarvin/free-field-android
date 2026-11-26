import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { isDemoAuth, useAuthContext, useProjectSelection } from "@ff/auth";
import { signOutSession } from "../session";
import { webgl2Info } from "../model/diagnostics";
import { getBlobStore } from "../storage";
import { ConfirmDialog } from "../shell/ConfirmDialog";
import { countUnsyncedOutbox } from "../data/wipe";
import { signOutAndWipe } from "../data/signOut";
import { clearCache } from "../diagnostics/clearCache";
import { appLog } from "../diagnostics/logger";
import { exportLogs } from "../diagnostics/exportLogs";
import { nativeLogExportDeps } from "../diagnostics/exportLogsNative";
import { usePersistResult } from "../diagnostics/persist";
import { computeStorageUsage, formatBytes, type StorageUsage } from "../diagnostics/storageUsage";
import { NotificationSettings } from "../notifications/NotificationSettings";
import { getAppInfo, type AppInfo } from "../diagnostics/appInfo";

export function MorePage() {
  const { app, user, project, signOut } = useAuthContext();
  const { setCurrentProject } = useProjectSelection();
  const persist = usePersistResult();
  const gl = webgl2Info();
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [signOutUnsynced, setSignOutUnsynced] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const refreshUsage = () => void computeStorageUsage(getBlobStore()).then(setUsage);
  useEffect(() => {
    refreshUsage();
    void getAppInfo().then(setInfo);
  }, []);

  async function onClearCache() {
    const r = await clearCache(getBlobStore());
    setNote(`Cleared ${r.files} cached file(s), ${formatBytes(r.bytes)}.`);
    refreshUsage();
  }

  async function onExportLogs() {
    try {
      const r = await exportLogs(appLog, nativeLogExportDeps, [`app: ${info?.version ?? "?"}`, `mode: ${isDemoAuth() ? "demo" : "backend"}`]);
      setNote(r.shared ? `Logs shared (${r.lines} lines).` : `Logs saved to ${r.uri}`);
    } catch (err) {
      setNote(`Could not export logs: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function confirmSignOut() {
    setBusy(true);
    await signOutAndWipe({ app, signOut, afterSignOut: isDemoAuth() ? signOutSession : undefined });
  }

  return (
    <section className="pad" data-testid="more-page">
      <h2>More</h2>

      <h3>Account</h3>
      <dl className="kv" data-testid="account">
        <dt>Signed in as</dt>
        <dd data-testid="account-email">{user?.email ?? "n/a"}</dd>
        <dt>Project</dt>
        <dd data-testid="current-project">{project?.name ?? project?.id ?? "none"}</dd>
        <dt>Role</dt>
        <dd>{project?.role ?? "n/a"}</dd>
      </dl>
      <ul className="list">
        <li>
          <button className="row" data-testid="switch-project" onClick={() => setCurrentProject(null)}>
            Switch project
          </button>
        </li>
        <li>
          <button
            className="row"
            data-testid="signout"
            onClick={() => void countUnsyncedOutbox().then(setSignOutUnsynced)}
          >
            Sign out
          </button>
        </li>
      </ul>

      <h3>Notifications</h3>
      <NotificationSettings />

      <h3>Offline</h3>
      <ul className="list">
        <li>
          <Link className="row" data-testid="open-offline" to="/offline">
            Offline buildings
          </Link>
        </li>
      </ul>

      <h3>Storage</h3>
      <dl className="kv" data-testid="storage">
        <dt>Offline files</dt>
        <dd data-testid="storage-blobs">
          {usage ? `${formatBytes(usage.blobBytes)} (${usage.blobCount} files)` : "…"}
        </dd>
        <dt>App data</dt>
        <dd data-testid="storage-origin">
          {usage ? `${formatBytes(usage.originUsage)} of ${formatBytes(usage.originQuota)}` : "…"}
        </dd>
        <dt>Protected from eviction</dt>
        <dd data-testid="storage-persist">{persist}</dd>
      </dl>
      <ul className="list">
        <li>
          <button className="row" data-testid="clear-cache" onClick={() => void onClearCache()}>
            Clear cache
          </button>
        </li>
        <li>
          <button className="row" data-testid="export-logs" onClick={() => void onExportLogs()}>
            Export logs
          </button>
        </li>
      </ul>
      {note && (
        <p className="muted" data-testid="more-note">
          {note}
        </p>
      )}

      <h3>Diagnostics</h3>
      <dl className="kv" data-testid="diagnostics">
        <dt>Version</dt>
        <dd data-testid="app-version">{info ? `${info.version}${info.build ? ` (${info.build})` : ""}` : "…"}</dd>
        <dt>Mode</dt>
        <dd>{isDemoAuth() ? "demo" : "backend"}</dd>
        <dt>WebGL2</dt>
        <dd>{gl.webgl2 ? "yes" : "no"}</dd>
        <dt>Renderer</dt>
        <dd>{gl.renderer ?? "n/a"}</dd>
      </dl>

      {signOutUnsynced !== null && (
        <ConfirmDialog
          title="Sign out?"
          confirmLabel={busy ? "Signing out…" : "Sign out and wipe"}
          danger
          testId="signout-dialog"
          onCancel={() => !busy && setSignOutUnsynced(null)}
          onConfirm={() => void confirmSignOut()}
        >
          {signOutUnsynced > 0 ? (
            <p className="error" data-testid="signout-warning">
              {signOutUnsynced} change{signOutUnsynced === 1 ? " has" : "s have"} not synced yet and will be lost.
            </p>
          ) : null}
          <p>Signing out removes all project data stored on this device.</p>
        </ConfirmDialog>
      )}
    </section>
  );
}
