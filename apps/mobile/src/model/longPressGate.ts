/**
 * Decides whether a viewer pick event may clear the long-press candidate ("New task here" bar).
 * The release of the long-press finger also produces a viewer pick; it must not clear the candidate it just
 * created, however late it is delivered (a busy main thread on a big federated scene can delay it by seconds,
 * so a time window is not reliable). The next touch-down starts a new gesture and re-arms clearing.
 */
export class LongPressGate {
  private firedInGesture = false;

  /** The long-press timer fired for the current gesture. */
  fired(): void {
    this.firedInGesture = true;
  }

  /** A new primary touch started. */
  newGesture(): void {
    this.firedInGesture = false;
  }

  shouldClearCandidate(): boolean {
    return !this.firedInGesture;
  }
}
