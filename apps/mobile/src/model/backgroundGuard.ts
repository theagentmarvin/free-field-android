/**
 * Memory-pressure guard. When the app goes to the background the WebView keeps the GL context and
 * the model's GPU buffers alive; Android may then kill the whole process. After `releaseAfterMs`
 * in the background the model is disposed (`onRelease`); when the app returns it is reloaded
 * (`onRestore`). A quick app switch (shorter than the delay) costs nothing.
 */
export interface BackgroundGuardDeps {
  releaseAfterMs: () => number;
  setTimer: (cb: () => void, ms: number) => unknown;
  clearTimer: (t: unknown) => void;
  onRelease: () => void;
  onRestore: () => void;
}

export class BackgroundGuard {
  private timer: unknown = null;
  private released = false;
  constructor(private deps: BackgroundGuardDeps) {}

  get isReleased(): boolean {
    return this.released;
  }

  hidden(): void {
    if (this.timer !== null || this.released) return;
    this.timer = this.deps.setTimer(() => {
      this.timer = null;
      this.released = true;
      this.deps.onRelease();
    }, this.deps.releaseAfterMs());
  }

  visible(): void {
    if (this.timer !== null) {
      this.deps.clearTimer(this.timer);
      this.timer = null;
    }
    if (this.released) {
      this.released = false;
      this.deps.onRestore();
    }
  }

  dispose(): void {
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = null;
  }
}

/** JS heap pressure from `performance.memory` (Chromium): used / limit, or null when unavailable. */
export function heapPressure(mem: { usedJSHeapSize: number; jsHeapSizeLimit: number } | undefined): number | null {
  if (!mem || !(mem.jsHeapSizeLimit > 0)) return null;
  return mem.usedJSHeapSize / mem.jsHeapSizeLimit;
}
