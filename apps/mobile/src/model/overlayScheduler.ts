/**
 * Render-on-demand loop for the DOM overlays (task pins, markers). Nothing runs while the view is
 * still: `kick()` starts a requestAnimationFrame loop that stops by itself after `idleFrames`
 * consecutive frames in which the viewport revision did not change.
 */
export interface OverlaySchedulerDeps {
  raf: (cb: () => void) => number;
  caf: (id: number) => void;
  /** opaque token that changes whenever the camera or canvas size changes */
  revision: () => number;
  /** called each frame; `changed` is true when the revision moved (or `kick(true)` forced it) */
  onFrame: (changed: boolean) => void;
  idleFrames?: number;
}

export class OverlayScheduler {
  private id: number | null = null;
  private idle = 0;
  private last = Number.NaN;
  private force = false;
  private disposed = false;
  frames = 0;
  runs = 0;

  constructor(private deps: OverlaySchedulerDeps) {}

  get running(): boolean {
    return this.id !== null;
  }

  /** Wake the loop. `force` makes the next frame report `changed` even if the camera did not move (pin list changed). */
  kick(force = false): void {
    if (this.disposed) return;
    this.idle = 0;
    if (force) this.force = true;
    if (this.id === null) {
      this.runs++;
      this.id = this.deps.raf(this.tick);
    }
  }

  /**
   * Watchdog entry: wake the loop only when the camera moved since the last frame the loop drew. A change the loop
   * already drew while it was running does not start another (idle) run.
   */
  wakeIfChanged(): boolean {
    if (this.disposed || this.id !== null || this.deps.revision() === this.last) return false;
    this.kick();
    return true;
  }

  private tick = (): void => {
    this.id = null;
    if (this.disposed) return;
    this.frames++;
    const rev = this.deps.revision();
    const changed = this.force || rev !== this.last;
    this.force = false;
    this.last = rev;
    this.idle = changed ? 0 : this.idle + 1;
    this.deps.onFrame(changed);
    if (this.idle < (this.deps.idleFrames ?? 8)) this.id = this.deps.raf(this.tick);
  };

  dispose(): void {
    this.disposed = true;
    if (this.id !== null) this.deps.caf(this.id);
    this.id = null;
  }
}
