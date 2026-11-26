import { useState } from "react";
import { useTaskEngine } from "@ff/tasks-react";
import { useNetworkStatus } from "../platform/network";
import { ConfirmDialog } from "../shell/ConfirmDialog";
import { friendlyError, groupOutbox, outboxCounts } from "../sync/outboxModel";
import { useOutboxRows } from "../sync/useOutbox";

/** Sync tab: the outbox, grouped by entity, with retry / discard. */
export function SyncPage() {
  const rows = useOutboxRows();
  const engine = useTaskEngine();
  const { online, connectionType } = useNetworkStatus();
  const [discardId, setDiscardId] = useState<string | null>(null);
  const groups = groupOutbox(rows);
  const counts = outboxCounts(rows);

  return (
    <section className="pad" data-testid="sync-page">
      <h2>Sync</h2>
      <p>
        Network: <strong>{online ? "online" : "offline"}</strong> <span className="muted">({connectionType})</span>
      </p>
      <p className="muted" data-testid="outbox-summary">
        {counts.pending} pending, {counts.failed} failed, {counts.sent} sent
      </p>
      {groups.length === 0 ? (
        <p className="muted" data-testid="outbox-empty">
          Everything is up to date.
        </p>
      ) : (
        groups.map((g) => (
          <div className="group" key={g.key} data-testid="outbox-group">
            <h4>{g.title}</h4>
            {g.items.map((it) => (
              <div className="item" key={it.id} data-testid="outbox-item" data-state={it.state}>
                <span className={`pill ${it.state}`}>{it.stateLabel}</span>
                <span className="grow">{it.label}</span>
                {it.canRetry && (
                  <button className="btn small" data-testid="outbox-retry" onClick={() => void engine?.retryNow(it.id)}>
                    Retry
                  </button>
                )}
                {it.canDiscard && (
                  <button className="btn small" data-testid="outbox-discard" onClick={() => setDiscardId(it.id)}>
                    Discard
                  </button>
                )}
                {it.error && <span className="err">{friendlyError(it.error)}</span>}
              </div>
            ))}
          </div>
        ))
      )}
      {discardId && (
        <ConfirmDialog
          title="Discard this change?"
          confirmLabel="Discard"
          danger
          testId="discard-dialog"
          onCancel={() => setDiscardId(null)}
          onConfirm={() => {
            void engine?.remove(discardId);
            setDiscardId(null);
          }}
        >
          It has not reached the server. Discarding removes it permanently.
        </ConfirmDialog>
      )}
    </section>
  );
}
