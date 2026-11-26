/**
 * Pan fling (inertia) math, kept pure so it can be unit-tested without a DOM.
 *
 * The viewer records recent pointer samples while panning; on release the velocity over the last
 * ~100 ms seeds an exponential decay: v(t) = v0 * exp(-t / tau). Displacement over a step is the
 * exact integral, so the result does not depend on the frame rate.
 */
export interface FlingSample {
  x: number;
  y: number;
  /** event time stamp, ms */
  t: number;
}

export interface Velocity {
  /** px per ms */
  vx: number;
  vy: number;
}

/** Only samples this recent count toward the release velocity. */
export const FLING_WINDOW_MS = 100;
/** A pointer that rested this long before release does not fling. */
export const FLING_STALE_MS = 150;
/** Velocity decays by 1/e every tau ms. */
export const FLING_TAU_MS = 325;
/** Below this speed (px/ms) the fling stops. */
export const FLING_MIN_SPEED = 0.02;
/** Safety cap (px/ms) so a glitchy sample cannot launch the plan. */
export const FLING_MAX_SPEED = 6;

export function releaseVelocity(samples: readonly FlingSample[], releaseT: number): Velocity {
  if (samples.length < 2) return { vx: 0, vy: 0 };
  const last = samples[samples.length - 1];
  if (releaseT - last.t > FLING_STALE_MS) return { vx: 0, vy: 0 };
  let first = last;
  for (let i = samples.length - 2; i >= 0; i--) {
    if (last.t - samples[i].t > FLING_WINDOW_MS) break;
    first = samples[i];
  }
  const dt = last.t - first.t;
  if (dt <= 0) return { vx: 0, vy: 0 };
  let vx = (last.x - first.x) / dt;
  let vy = (last.y - first.y) / dt;
  const sp = Math.hypot(vx, vy);
  if (sp > FLING_MAX_SPEED) {
    vx = (vx / sp) * FLING_MAX_SPEED;
    vy = (vy / sp) * FLING_MAX_SPEED;
  }
  return sp < FLING_MIN_SPEED ? { vx: 0, vy: 0 } : { vx, vy };
}

/** Advance a fling by `dtMs`: the displacement and the decayed velocity. `done` once it is too slow. */
export function flingStep(v: Velocity, dtMs: number, tau = FLING_TAU_MS): { dx: number; dy: number; v: Velocity; done: boolean } {
  const decay = Math.exp(-dtMs / tau);
  const k = tau * (1 - decay); // integral of exp(-t/tau) over dt
  const next = { vx: v.vx * decay, vy: v.vy * decay };
  return { dx: v.vx * k, dy: v.vy * k, v: next, done: Math.hypot(next.vx, next.vy) < FLING_MIN_SPEED };
}

/** Total distance a fling would cover (for tests and tuning). */
export const flingDistance = (v: Velocity, tau = FLING_TAU_MS): { dx: number; dy: number } => ({ dx: v.vx * tau, dy: v.vy * tau });
