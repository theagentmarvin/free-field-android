import type { MutableRefObject } from "react";

/** The first-person walker in world space (metres, Y up). `yaw` uses the 3D view's convention: 0 looks along -Z, positive turns right. */
export interface LinkWalker {
  x: number;
  z: number;
  /** elevation of the storey the eye stands on */
  floorY: number;
  yaw: number;
}

/** What the page can do to the 3D pane. Filled by the ModelView that is bound to the Link view. */
export interface LinkviewControl {
  /** Move / turn / change level. Applied at once when the walker is active, else remembered and applied when the model is ready. */
  place(p: Partial<LinkWalker>): void;
  current(): LinkWalker | null;
}

/**
 * Opt-in binding of a ModelView to the Link view: the view starts (and after a renderer recovery restarts) in first
 * person at `initial`, reports every move or turn through `onChange`, and offers no orbit mode.
 */
export interface LinkviewBinding {
  initial: LinkWalker;
  onChange(w: LinkWalker): void;
  controlRef: MutableRefObject<LinkviewControl | null>;
}

/** What the 3D view knows right now, read when the user opens the Link view from it. */
export interface LinkContext {
  storeyName: string | null;
  floorY: number | null;
  x: number | null;
  z: number | null;
  /** walk yaw (see LinkWalker) or null when the view has no heading yet */
  yaw: number | null;
}
export interface LinkContextHandle {
  read(): LinkContext;
}
