import type { IfcViewerReadyContext } from "@ff/viewer-react";
import type * as OBC from "@thatopen/components";
import * as THREE from "three";
import { boxCenter, isFiniteBox, unionBoxes, type Box, type Vec3 } from "./viewMath";

/** What the viewer hands out through `onReady`: world, renderer, camera and the fragments manager. */
export type Engine = Pick<IfcViewerReadyContext, "fragments" | "renderer" | "camera">;
export type Fragments = OBC.FragmentsManager;

export function getRenderer(engine: Engine | null): THREE.WebGLRenderer | null {
  return (engine?.renderer.three as THREE.WebGLRenderer | undefined) ?? null;
}

/** Set the resting pixel ratio. The viewer's motion mode scales this down while the camera moves. */
export function applyPixelRatio(engine: Engine | null, ratio: number): boolean {
  const r = getRenderer(engine);
  if (!r) return false;
  if (Math.abs(r.getPixelRatio() - ratio) > 1e-3) r.setPixelRatio(ratio);
  return true;
}

export function modelsBox(engine: Engine | null): Box | null {
  const fragments = engine?.fragments;
  if (!fragments) return null;
  const boxes: Box[] = [];
  for (const m of fragments.core.models.list.values()) {
    const b = (m as { box?: THREE.Box3 }).box;
    if (b && !b.isEmpty()) boxes.push({ min: [b.min.x, b.min.y, b.min.z], max: [b.max.x, b.max.y, b.max.z] });
  }
  return unionBoxes(boxes);
}

/** World box of every loaded model (debug/e2e: federated alignment check). */
export function perModelBoxes(engine: Engine | null): Array<{ modelId: string; min: Vec3; max: Vec3 }> {
  const out: Array<{ modelId: string; min: Vec3; max: Vec3 }> = [];
  for (const [modelId, m] of engine?.fragments.core.models.list ?? []) {
    const b = (m as { box?: THREE.Box3 }).box;
    if (b && !b.isEmpty()) out.push({ modelId, min: [b.min.x, b.min.y, b.min.z], max: [b.max.x, b.max.y, b.max.z] });
  }
  return out;
}

export function modelsCenter(engine: Engine | null): Vec3 | null {
  const b = modelsBox(engine);
  return isFiniteBox(b) ? boxCenter(b) : null;
}

export interface ElementHit {
  modelId: string;
  localId: number;
  point: Vec3;
}

/**
 * Closest element under a screen point (client CSS pixels), straight from the fragments raycaster.
 * Used for long-press (the viewer's pick API is click-driven) and the e2e probes; taps go through the
 * viewer's own pick callback.
 */
export async function raycastAt(engine: Engine | null, clientX: number, clientY: number, timings?: Array<{ modelId: string; ms: number }>): Promise<ElementHit | null> {
  const canvas = getRenderer(engine)?.domElement;
  const camera = engine?.camera.three;
  if (!engine || !canvas || !camera) return null;
  const mouse = new THREE.Vector2(clientX, clientY);
  let best: { hit: ElementHit; dist: number } | null = null;
  for (const [modelId, model] of engine.fragments.core.models.list) {
    const t0 = timings ? performance.now() : 0;
    try {
      const res = await model.raycast({ camera: camera as THREE.PerspectiveCamera, mouse, dom: canvas });
      if (res && (best === null || res.distance < best.dist)) {
        best = { hit: { modelId, localId: res.localId, point: [res.point.x, res.point.y, res.point.z] }, dist: res.distance };
      }
    } catch {
      /* a model mid-dispose must not break picking */
    }
    timings?.push({ modelId, ms: Math.round(performance.now() - t0) });
  }
  return best?.hit ?? null;
}

/** Debug/e2e: force a context loss on the live canvas. Returns false when the extension is missing. */
export function loseContext(engine: Engine | null): boolean {
  const gl = getRenderer(engine)?.getContext();
  const ext = gl?.getExtension("WEBGL_lose_context");
  if (!ext) return false;
  ext.loseContext();
  return true;
}
