import { useNetworkStatus } from "../platform/network";
import { CHIP_LABEL, chipState, useBackendUnreachable } from "../platform/reachability";
import { useOutboxCounts } from "../sync/useOutbox";

/** Header chip: Offline (no network) / No connection to server (link up, backend unreachable) / Online, plus pending count and failed badge. */
export function SyncChip() {
  const { online } = useNetworkStatus();
  const unreachable = useBackendUnreachable();
  const { pending, failed } = useOutboxCounts();
  const state = chipState(online, unreachable);
  return (
    <span
      className={`sync-chip ${state === "online" ? "is-online" : state === "offline" ? "is-offline" : "is-unreachable"}`}
      data-testid="sync-chip"
      data-state={state}
      data-pending={pending}
      data-failed={failed}
      role="status"
    >
      <span className="dot" aria-hidden />
      {CHIP_LABEL[state]}
      {pending > 0 && (
        <span className="badge" data-testid="chip-pending" title="Pending changes">
          {pending}
        </span>
      )}
      {failed > 0 && (
        <span className="badge failed" data-testid="chip-failed" title="Failed changes">
          {failed} failed
        </span>
      )}
    </span>
  );
}
