import { describe, expect, it, vi } from "vitest";
import { MemoryBlobStore } from "../storage";
import { addPhoto, applyAnnotations, discardTaskPhotos, originalKey, readSidecar, removePhoto, type PhotoDeps } from "./photoStore";

function deps() {
  let n = 0;
  const registered = new Map<string, Blob>();
  const release = vi.fn((k: string) => void registered.delete(k));
  const d: PhotoDeps = {
    process: async () => ({ blob: new Blob(["flat0"], { type: "image/jpeg" }), width: 100, height: 50 }),
    flatten: async (_o, shapes) => new Blob([`flat-${shapes.length}`], { type: "image/jpeg" }),
    register: (k, b) => void registered.set(k, b),
    release,
    files: new MemoryBlobStore(),
    newId: () => `id${n++}`,
  };
  return { d, registered, release };
}

describe("photo store", () => {
  it("keeps original + sidecar and registers the flattened copy", async () => {
    const { d, registered } = deps();
    const p = await addPhoto("t1", new Blob(["ORIGINAL"]), d);
    expect(p.blobKey).toBe("t1-id0");
    expect(p.sha256).toHaveLength(64);
    expect(registered.has(p.blobKey)).toBe(true);
    expect(new TextDecoder().decode((await d.files.read(originalKey("t1", p.blobKey)))!)).toBe("ORIGINAL");
    expect((await readSidecar("t1", p.blobKey, d.files))?.shapes).toEqual([]);
  });
  it("re-annotates from the original with a new key and drops the old copy", async () => {
    const { d, registered, release } = deps();
    const p = await addPhoto("t1", new Blob(["ORIGINAL"]), d);
    const shapes = [{ id: "s", kind: "rect" as const, color: "#f00", width: 0.01, from: [0, 0] as [number, number], to: [1, 1] as [number, number] }];
    const q = await applyAnnotations("t1", p, shapes, d);
    expect(q.blobKey).not.toBe(p.blobKey);
    expect(q.sha256).not.toBe(p.sha256);
    expect(release).toHaveBeenCalledWith(p.blobKey);
    expect(registered.has(q.blobKey)).toBe(true);
    expect(await d.files.stat(originalKey("t1", p.blobKey))).toBeNull();
    expect((await readSidecar("t1", q.blobKey, d.files))?.shapes).toHaveLength(1);
    expect(await d.files.stat(originalKey("t1", q.blobKey))).not.toBeNull();
  });
  it("removes and discards", async () => {
    const { d } = deps();
    const a = await addPhoto("t1", new Blob(["a"]), d);
    const b = await addPhoto("t1", new Blob(["b"]), d);
    await removePhoto("t1", a, d);
    expect(await d.files.stat(originalKey("t1", a.blobKey))).toBeNull();
    await discardTaskPhotos("t1", d.files);
    expect(await d.files.list("task-photos/t1/")).toEqual([]);
    expect(b.blobKey).toBe("t1-id1");
  });
});
