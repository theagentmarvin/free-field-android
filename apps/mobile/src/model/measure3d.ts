import * as OBC from "@thatopen/components";
import * as THREE from "three";
import * as OBCF from "@thatopen/components-front";
import type { IfcViewerReadyContext, MeasureVariant } from "@ff/viewer-react";
import { PlacedPoints } from "./measureState";
import { testHooksEnabled } from "../dev/flag";
import { disposeHelper, ndcFrom, planeFromHit, planeHelper, rayOnPlane } from "../measure/workPlane";

const CLASSES = {
  length: OBCF.LengthMeasurement,
  area: OBCF.AreaMeasurement,
  angle: OBCF.AngleMeasurement,
  volume: OBCF.VolumeMeasurement,
} as const;

interface Ev {
  add(cb: () => void): void;
  remove(cb: () => void): void;
  trigger?: () => void;
}
/** The slice of an engine measurement component this controller touches. */
interface Comp {
  enabled: boolean;
  lastPick?: unknown;
  create?: () => unknown;
  onPointerMove?: Ev;
  list?: Iterable<unknown>;
  _vertexPicker?: { get: (...a: unknown[]) => Promise<unknown> };
  snappings?: number[];
}
type Pick = { point?: { x: number; y: number; z: number } } | null;

export interface WorkPlane {
  plane: THREE.Plane;
  center: THREE.Vector3;
  size: number;
}

/** Pointer id of the events this controller synthesizes (never a real finger). */
const SYN_ID = 4242;

/**
 * Drives the engine's own measurement component from the tablet's touch input. The viewer arms the component
 * (`setMeasureMode`) and turns a canvas `click` into a point; a finger needs two things on top: an aim that follows it
 * (so the snap preview and the loupe track the finger, and the point is placed where it LIFTS; the camera keeps one-finger orbit, the
 * caller's gesture classifier decides whether a touch is an orbit, a tap or an aim), and exact placement
 * independent of the pick that happened to be in flight. So the finger's pointer moves are replayed to the engine as
 * synthetic `pointermove`, and on lift one synthetic press + `click` at the final position places the point once the
 * engine's snap pick for that position has landed. No geometry is copied: points are the engine's own picks.
 */
export class Measure3D {
  private readonly comp: Comp;
  private readonly canvas: HTMLCanvasElement;
  private readonly placed: PlacedPoints<unknown>;
  private caster: { castRay: (d?: unknown) => Promise<unknown> } | null = null;
  private origCast: ((d?: unknown) => Promise<unknown>) | null = null;
  private xy: { x: number; y: number } | null = null;
  private snap: HTMLCanvasElement | null = null;
  private busy = false;
  /** The measuring plane (set by tapping a surface first): every point of a length / area / angle lies on it. */
  private plane: THREE.Plane | null = null;
  private helper: THREE.Group | null = null;
  private planeAt: { center: THREE.Vector3; size: number } | null = null;
  private disposed = false;

  constructor(
    private readonly ctx: IfcViewerReadyContext,
    readonly variant: MeasureVariant,
    private readonly requestRender: () => void = () => {},
  ) {
    this.comp = ctx.components.get(CLASSES[variant] as unknown as new (c: typeof ctx.components) => never) as unknown as Comp;
    this.canvas = ctx.renderer.three.domElement as HTMLCanvasElement;
    this.placed = new PlacedPoints<unknown>(variant);
    this.installPick();
  }

  get count(): number {
    return this.placed.count;
  }

  /** Volume measures whole elements; every other variant draws on a plane picked first. */
  get needsPlane(): boolean {
    return this.variant !== "volume";
  }

  get hasPlane(): boolean {
    return this.plane !== null;
  }

  /**
   * Set the measuring plane from the surface under (x, y): the face that was hit, its normal snapped to a world axis when it is
   * nearly one. Resolves false when there is no model surface there.
   */
  async setPlaneAt(x: number, y: number): Promise<boolean> {
    try {
      this.ctx.renderer.three.render(this.ctx.world.scene.three, this.ctx.camera.three);
    } catch {
      /* pick on the last frame */
    }
    const hit = (await this.pickSettled({ x, y })) as { point?: THREE.Vector3; normal?: THREE.Vector3 } | null;
    if (testHooksEnabled()) {
      (window as unknown as { __ffmPlane?: unknown }).__ffmPlane = { x, y, hit: hit?.point ? [hit.point.x, hit.point.y, hit.point.z] : null, normal: hit?.normal ? [hit.normal.x, hit.normal.y, hit.normal.z] : null, models: this.ctx.fragments.core.models.list.size };
    }
    if (!hit?.point || this.disposed) return false; // a pick that lands after the session ended sets nothing
    const point = new THREE.Vector3().copy(hit.point);
    const normal = hit.normal ? new THREE.Vector3().copy(hit.normal) : null;
    const cam = this.ctx.camera.three.position;
    this.usePlane({ plane: planeFromHit(point, normal, cam), center: point, size: Math.max(2, Math.min(60, cam.distanceTo(point) * 0.6)) });
    return true;
  }

  /** The current plane, to carry over to the next variant's controller (switching Length to Area keeps the plane). */
  exportPlane(): WorkPlane | null {
    return this.plane && this.planeAt ? { plane: this.plane.clone(), center: this.planeAt.center.clone(), size: this.planeAt.size } : null;
  }

  usePlane(wp: WorkPlane): void {
    this.clearPlane();
    this.plane = wp.plane.clone();
    this.planeAt = { center: wp.center.clone(), size: wp.size };
    this.helper = planeHelper(this.plane, wp.center, wp.size);
    this.ctx.world.scene.three.add(this.helper);
    this.requestRender();
  }

  /** Forget the plane (Change plane, or the session ends); the next tap picks a new one. */
  clearPlane(): void {
    if (!this.plane && !this.helper) return;
    this.plane = null;
    this.planeAt = null;
    disposeHelper(this.helper);
    this.helper = null;
    this.requestRender();
  }

  /** The point on the measuring plane under the client point (x, y), as an engine pick; null off the plane. */
  private planePick(at: { x: number; y: number }): unknown {
    if (!this.plane) return null;
    const p = rayOnPlane(this.ctx.camera.three, ndcFrom(at.x, at.y, this.canvas.getBoundingClientRect()), this.plane);
    if (!p) return null;
    return { point: p, normal: this.plane.normal.clone(), distance: p.distanceTo(this.ctx.camera.three.position) };
  }

  /**
   * The engine's ray cast reads a GPU id pass, which the tablet's lean tiles do not have (see memoryConfig: leanTiles).
   * Its measurement components only need "what is under this pixel": answer it with the fragments worker raycast (the one
   * taps and long press already use) and then resolve vertex / edge / face snapping exactly as the engine does. No geometry is
   * read or copied on the main thread; only the hit and the snap candidates come back.
   */
  private installPick(): void {
    try {
      const rc = this.ctx.components.get(OBC.Raycasters).get(this.ctx.world) as unknown as { castRay: (d?: unknown) => Promise<unknown> };
      this.caster = rc;
      this.origCast = rc.castRay.bind(rc);
      rc.castRay = (d?: unknown) => this.pickAt(d as { snappingClasses?: number[] } | undefined);
    } catch {
      this.caster = null;
    }
  }

  private async pickAt(data?: { snappingClasses?: number[] }): Promise<unknown> {
    const at = this.xy;
    if (!at) return null;
    return this.plane && this.needsPlane ? this.planePick(at) : this.pickAtPoint(at, data);
  }

  /**
   * A model pick right after a touch can miss while the view is still being re-streamed for the camera: ask again for a moment
   * before believing a miss (1.5 s at most).
   */
  private async pickSettled(at: { x: number; y: number }, data?: { snappingClasses?: number[] }, ms = 1500): Promise<unknown> {
    const t0 = performance.now();
    for (;;) {
      const r = await this.pickAtPoint(at, data);
      if (r || performance.now() - t0 > ms) return r;
      await new Promise((res) => setTimeout(res, 150));
    }
  }

  private async pickAtPoint(at: { x: number; y: number }, data?: { snappingClasses?: number[] }): Promise<unknown> {
    const camera = this.ctx.camera.three;
    const mouse = new THREE.Vector2(at.x, at.y);
    let best: { res: { point: THREE.Vector3; normal?: THREE.Vector3; distance: number; localId: number }; modelId: string } | null = null;
    for (const [modelId, model] of this.ctx.fragments.core.models.list) {
      try {
        const res = await model.raycast({ camera: camera as THREE.PerspectiveCamera, mouse, dom: this.canvas });
        if (res && (!best || res.distance < best.res.distance)) best = { res: res as never, modelId };
      } catch {
        /* a model mid-dispose must not break measuring */
      }
    }
    if (!best) return null;
    const { res, modelId } = best;
    const out: Record<string, unknown> = { localId: res.localId, point: res.point, normal: res.normal, distance: res.distance, fragments: this.ctx.fragments.core.models.list.get(modelId) };
    const classes = data?.snappingClasses;
    if (classes && classes.length > 0) {
      try {
        const snap = (await this.ctx.components.get(OBC.SnapResolvers).get().resolve(res.point, modelId, res.localId, classes as never)) as Record<string, unknown> | null;
        if (snap) {
          out.point = snap.point;
          if (snap.normal) out.normal = snap.normal;
          out.snappingClass = snap.snappingClass;
          for (const k of ["facePoints", "faceIndices", "snappedEdgeP1", "snappedEdgeP2"]) if (snap[k]) out[k] = snap[k];
        }
      } catch {
        /* no snap candidate: the plain surface point stands */
      }
    }
    return out;
  }

  dispose(): void {
    this.disposed = true;
    if (this.caster && this.origCast) this.caster.castRay = this.origCast;
    this.caster = null;
    this.clearPlane();
    this.releaseSnapshot();
  }

  private move(x: number, y: number): void {
    this.xy = { x, y };
    const ev = new PointerEvent("pointermove", { pointerId: SYN_ID, pointerType: "mouse", isPrimary: true, clientX: x, clientY: y, bubbles: true });
    // The engine's raycaster reads its own `Mouse` helper: feed it directly too (the viewer's drag guard does the same for taps).
    try {
      const rc = this.ctx.components.get(OBC.Raycasters).get(this.ctx.world) as unknown as { mouse?: { updateMouseInfo?: (e: Event) => void } };
      rc.mouse?.updateMouseInfo?.(ev);
    } catch {
      /* engine shape drift: the DOM event below still reaches its listeners */
    }
    this.canvas.dispatchEvent(ev);
  }

  /** What the last snap pick landed on: a vertex, an edge or a plain face; null when nothing is under the aim. */
  snapKind(): "vertex" | "edge" | "face" | "plane" | null {
    const pick = this.comp.lastPick as { point?: unknown; snappingClass?: number } | null | undefined;
    if (!pick?.point) return null;
    if (this.plane && this.needsPlane) return "plane";
    return pick.snappingClass === 0 ? "vertex" : pick.snappingClass === 1 ? "edge" : "face";
  }

  /** `cb` runs whenever the engine's snap pick for the aim lands (the preview moved). Returns the unsubscribe. */
  onPick(cb: () => void): () => void {
    const ev = this.comp.onPointerMove;
    ev?.add(cb);
    return () => ev?.remove(cb);
  }

  /** The finger is at (x, y): the engine's snap preview follows. */
  aim(x: number, y: number): void {
    this.move(x, y);
  }

  /**
   * The finger lifted at (x, y): place a point there. Resolves false when nothing measurable is there (off the plane, or no
   * element under the finger for Volume), true otherwise.
   *
   * The pick is computed here, for exactly this position (on the plane: the view ray meets it; Volume: the element under the
   * finger), and handed straight to the engine component's `create`. Nothing waits on the engine's own pointer-move pick,
   * which it skips while it believes the camera is being touched: that made a quick tap miss.
   */
  async place(x: number, y: number): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    try {
      try {
        this.ctx.renderer.three.render(this.ctx.world.scene.three, this.ctx.camera.three);
      } catch {
        /* a frame that cannot be drawn right now: the pick still uses the current camera */
      }
      this.xy = { x, y };
      const pick = (this.plane && this.needsPlane ? this.planePick({ x, y }) : await this.pickSettled({ x, y }, { snappingClasses: this.comp.snappings })) as Pick;
      if (testHooksEnabled()) {
        const pl = this.plane ? [this.plane.normal.x, this.plane.normal.y, this.plane.normal.z, this.plane.constant] : null;
        (window as unknown as { __ffmMeasure?: unknown }).__ffmMeasure = { x, y, pick: pick?.point ?? null, plane: pl };
      }
      if (!pick?.point) return false;
      if (!(await this.feed(pick))) {
        // engine shape drift: fall back to the viewer's click path
        const opts = { pointerId: SYN_ID, pointerType: "mouse", isPrimary: true, clientX: x, clientY: y, button: 0, bubbles: true };
        this.canvas.dispatchEvent(new PointerEvent("pointerdown", { ...opts, buttons: 1 }));
        this.canvas.dispatchEvent(new PointerEvent("pointerup", { ...opts, buttons: 0 }));
        this.canvas.dispatchEvent(new MouseEvent("click", { clientX: x, clientY: y, button: 0, detail: 1, bubbles: true }));
      }
      this.placed.push(pick);
      if (this.placed.completed()) this.placed.reset();
      this.requestRender();
      return true;
    } finally {
      this.busy = false;
    }
  }

  /** Hand one pick to the engine component as its next point (what its click handler does, minus its own pick). */
  private async feed(pick: unknown): Promise<boolean> {
    const vp = this.comp._vertexPicker;
    if (!vp || typeof this.comp.create !== "function") return false;
    const origGet = vp.get;
    const origLast = this.comp.lastPick;
    try {
      vp.get = async () => pick;
      this.comp.lastPick = pick;
      // Length and Area take every point after the first from their live preview, which follows the pointer-move pick: move
      // the preview onto this pick first (what a real pointer move does), then commit it.
      this.comp.onPointerMove?.trigger?.();
      await this.comp.create();
    } finally {
      vp.get = origGet;
      this.comp.lastPick = origLast;
    }
    return true;
  }

  /** The engine committed the measurement (or it was cancelled): forget the draft. */
  resetDraft(): void {
    this.placed.reset();
  }

  /**
   * Undo the last point: cancel the engine's draft and replay the remaining picks. The replay feeds the stored pick
   * straight to the component (no camera dependence), so it rebuilds exactly what was there.
   */
  async undo(cancel: () => void): Promise<boolean> {
    if (this.placed.count === 0) return false;
    const keep = this.placed.undo();
    cancel();
    if (!this.comp._vertexPicker || typeof this.comp.create !== "function") {
      this.placed.reset();
      return false;
    }
    for (const pick of keep) await this.feed(pick);
    this.requestRender();
    return true;
  }

  /**
   * A bitmap of the scene for the loupe, taken once when the finger goes down (the camera is locked while one finger
   * aims, so it stays valid). Rendering first makes the drawing buffer readable; it is dropped on lift.
   */
  snapshot(): HTMLCanvasElement | null {
    try {
      const r = this.ctx.renderer.three;
      r.render(this.ctx.world.scene.three, this.ctx.camera.three);
      const src = r.domElement as HTMLCanvasElement;
      const off = (this.snap ??= document.createElement("canvas"));
      off.width = src.width;
      off.height = src.height;
      off.getContext("2d")?.drawImage(src, 0, 0);
      return off;
    } catch {
      return null;
    }
  }

  releaseSnapshot(): void {
    if (this.snap) {
      this.snap.width = 0;
      this.snap.height = 0;
      this.snap = null;
    }
  }

  /** e2e probe: the engine's own item geometry for every measurement of this kind. */
  items(): unknown[] {
    return this.comp.list ? [...this.comp.list] : [];
  }
}

/** e2e probe for every variant (independent of the active one). */
export function engineItems(ctx: IfcViewerReadyContext, variant: MeasureVariant): unknown[] {
  const c = ctx.components.get(CLASSES[variant] as unknown as new (c: typeof ctx.components) => never) as unknown as Comp;
  return c.list ? [...c.list] : [];
}
