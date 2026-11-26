import * as THREE from "three";

/**
 * The measuring plane for 3D measurements. A measurement starts by tapping a surface: that face becomes the plane every point
 * of the measurement lies on, the way drafting tools set a work plane before drawing. Points are then the intersection of the
 * finger's view ray with the plane: exact, instant and independent of what happens to be under the finger (no model pick per
 * point, no snap that drags a point metres away).
 */

/** Building geometry is mostly axis-aligned: a face normal within this angle of an axis is taken as that axis. */
export const AXIS_SNAP_DEG = 6;

const AXES = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];

/** The unit normal, snapped to the nearest world axis when it is within `deg` of it (sign kept). */
export function snapNormal(n: THREE.Vector3, deg = AXIS_SNAP_DEG): THREE.Vector3 {
  const u = n.clone().normalize();
  const cos = Math.cos((deg * Math.PI) / 180);
  for (const a of AXES) {
    const d = u.dot(a);
    if (Math.abs(d) >= cos) return new THREE.Vector3(a.x && Math.sign(d), a.y && Math.sign(d), a.z && Math.sign(d));
  }
  return u;
}

/**
 * The plane through `point` with the face normal `normal` (snapped to an axis when close), oriented towards the camera.
 * Without a usable normal, the world axis that best faces the camera is used.
 */
export function planeFromHit(point: THREE.Vector3, normal: THREE.Vector3 | null | undefined, cameraPos: THREE.Vector3): THREE.Plane {
  const toCam = cameraPos.clone().sub(point);
  let n: THREE.Vector3;
  if (normal && normal.lengthSq() > 1e-12) n = snapNormal(normal);
  else {
    const v = toCam.clone().normalize();
    n = AXES.reduce((best, a) => (Math.abs(v.dot(a)) > Math.abs(v.dot(best)) ? a : best), AXES[1]).clone();
  }
  if (n.dot(toCam) < 0) n.negate();
  n.set(n.x + 0, n.y + 0, n.z + 0); // no signed zeros
  return new THREE.Plane().setFromNormalAndCoplanarPoint(n, point);
}

/** Normalized device coordinates of a client point inside `rect`. */
export function ndcFrom(x: number, y: number, rect: { left: number; top: number; width: number; height: number }): THREE.Vector2 {
  return new THREE.Vector2(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1);
}

/**
 * Where the view ray through `ndc` meets `plane`; null when the ray runs parallel to it, points away from it, or meets it
 * beyond `maxDist` (a grazing angle would put the point kilometres away).
 */
export function rayOnPlane(camera: THREE.Camera, ndc: THREE.Vector2, plane: THREE.Plane, maxDist = 5000): THREE.Vector3 | null {
  const rc = new THREE.Raycaster();
  rc.setFromCamera(ndc, camera);
  const out = new THREE.Vector3();
  if (!rc.ray.intersectPlane(plane, out)) return null;
  if (out.distanceTo(rc.ray.origin) > maxDist) return null;
  return out;
}

/** A translucent square with an outline marking the plane around `center`, `size` metres across. */
export function planeHelper(plane: THREE.Plane, center: THREE.Vector3, size: number, color = 0x2563eb): THREE.Group {
  const g = new THREE.Group();
  g.name = "ffm-work-plane";
  const geo = new THREE.PlaneGeometry(size, size);
  const fill = new THREE.Mesh(
    geo,
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.14, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
  );
  const edge = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.8 }));
  fill.renderOrder = 10;
  edge.renderOrder = 11;
  g.add(fill, edge);
  // PlaneGeometry faces +Z: turn it to the plane's normal and sit it on the plane under `center`
  g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), plane.normal);
  const p = new THREE.Vector3();
  plane.projectPoint(center, p);
  g.position.copy(p);
  return g;
}

export function disposeHelper(g: THREE.Object3D | null): void {
  if (!g) return;
  g.removeFromParent();
  g.traverse((o) => {
    const m = o as THREE.Mesh;
    m.geometry?.dispose();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else mat?.dispose();
  });
}
