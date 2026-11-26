import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { disposeHelper, ndcFrom, planeFromHit, planeHelper, rayOnPlane, snapNormal } from "./workPlane";

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

describe("snapNormal", () => {
  it("snaps a nearly vertical normal to +Y / -Y and keeps the sign", () => {
    expect(snapNormal(v(0.05, 1, 0)).toArray()).toEqual([0, 1, 0]);
    expect(snapNormal(v(0, -1, 0.04)).toArray()).toEqual([0, -1, 0]);
  });
  it("leaves a sloped normal alone (normalized)", () => {
    const n = snapNormal(v(1, 1, 0));
    expect(n.length()).toBeCloseTo(1);
    expect(n.x).toBeCloseTo(Math.SQRT1_2);
  });
});

describe("planeFromHit", () => {
  const cam = v(0, 10, 10);
  it("a floor hit gives a horizontal plane through the point, facing the camera", () => {
    const p = planeFromHit(v(2, 3, 1), v(0.02, -1, 0), cam);
    expect(p.normal.toArray()).toEqual([0, 1, 0]);
    expect(p.distanceToPoint(v(50, 3, -40))).toBeCloseTo(0);
  });
  it("without a normal, the axis that best faces the camera", () => {
    const p = planeFromHit(v(0, 0, 0), null, v(1, 0.5, 20));
    expect(p.normal.toArray()).toEqual([0, 0, 1]);
  });
});

describe("rayOnPlane", () => {
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
  camera.position.set(0, 10, 0);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const floor = new THREE.Plane(v(0, 1, 0), 0);

  it("the screen centre looking down lands under the camera", () => {
    const p = rayOnPlane(camera, new THREE.Vector2(0, 0), floor)!;
    expect(p.x).toBeCloseTo(0);
    expect(p.y).toBeCloseTo(0);
    expect(p.z).toBeCloseTo(0);
  });
  it("a plane behind the camera gives null", () => {
    expect(rayOnPlane(camera, new THREE.Vector2(0, 0), new THREE.Plane(v(0, 1, 0), -20))).toBeNull();
  });
  it("a grazing hit beyond maxDist gives null", () => {
    const side = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
    side.position.set(0, 0.01, 0);
    side.lookAt(100, 0.01, 0);
    side.updateMatrixWorld();
    expect(rayOnPlane(side, new THREE.Vector2(0, -0.0001), floor, 50)).toBeNull();
  });
});

describe("ndcFrom and the helper", () => {
  it("maps the rect corners to -1..1", () => {
    const r = { left: 100, top: 50, width: 200, height: 100 };
    expect(ndcFrom(100, 50, r).toArray()).toEqual([-1, 1]);
    expect(ndcFrom(300, 150, r).toArray()).toEqual([1, -1]);
  });
  it("the helper sits on the plane, turned to its normal, and disposes cleanly", () => {
    const plane = new THREE.Plane(v(1, 0, 0), -4); // x = 4
    const g = planeHelper(plane, v(9, 2, 3), 6);
    expect(g.position.toArray()).toEqual([4, 2, 3]);
    const n = v(0, 0, 1).applyQuaternion(g.quaternion);
    expect(n.x).toBeCloseTo(1);
    const scene = new THREE.Scene();
    scene.add(g);
    disposeHelper(g);
    expect(scene.children).toHaveLength(0);
  });
});
