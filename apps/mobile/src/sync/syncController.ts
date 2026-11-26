/**
 * Connects connectivity and app-lifecycle events to the outbox engine.
 *
 *  - network came back  -> revive rows that failed only because of the network, then drain
 *  - app resumed        -> re-check connectivity (may have changed while backgrounded) and drain
 *
 * Cold-start repair (`recoverStale`, retention prune, first drain) runs inside
 * the shared engine the first time it is created (`getTaskEngine`), which the
 * app mounts at startup through <SyncController/>.
 */
export interface SyncEngineLike {
  drain(): Promise<void>;
  reviveNetworkFailed(): Promise<number>;
}

export interface SyncControllerDeps {
  engine: SyncEngineLike;
  /** Subscribe to online flips. */
  onOnlineChange(cb: (online: boolean) => void): () => void;
  /** Subscribe to app resume. */
  onResume(cb: () => void): () => void;
  /** Re-read OS connectivity; resolves once the snapshot is current. */
  refreshNetwork(): Promise<void>;
  isOnline(): boolean;
  onError?(err: unknown): void;
}

export function startSyncController(deps: SyncControllerDeps): () => void {
  const swallow = (err: unknown) => deps.onError?.(err);
  const kick = async (): Promise<void> => {
    await deps.engine.reviveNetworkFailed();
    await deps.engine.drain();
  };
  const offNet = deps.onOnlineChange((online) => {
    if (online) void kick().catch(swallow);
  });
  const offResume = deps.onResume(() => {
    void deps
      .refreshNetwork()
      .then(() => (deps.isOnline() ? kick() : undefined))
      .catch(swallow);
  });
  return () => {
    offNet();
    offResume();
  };
}
