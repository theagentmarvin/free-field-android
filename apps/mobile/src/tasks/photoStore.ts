import { getTaskBlobStore, sha256Hex } from "@ff/tasks";
import { registerBlob, releaseBlob, type ComposePhoto } from "@ff/tasks-react";
import { getBlobStore, type BlobStore } from "../storage";
import { flattenAnnotated } from "./annotate/flatten";
import type { Shape } from "./annotate/model";
import { processPhoto, type ProcessedImage } from "./imageProcess";

/**
 * Where task photos live while they wait for upload.
 *
 *  - The flattened JPEG (what gets uploaded) goes through `registerBlob`: the
 *    `@ff/tasks` outbox reads photo bytes from its own durable blob store, so
 *    the upload pipeline is reused unchanged.
 *  - The ORIGINAL capture and the annotation shapes go to the app BlobStore
 *    (Capacitor Filesystem), so annotations stay editable and the untouched
 *    photo is kept on the device.
 */
export interface PhotoDeps {
  process(source: Blob): Promise<ProcessedImage>;
  flatten(original: Blob, shapes: readonly Shape[]): Promise<Blob>;
  register(key: string, blob: Blob): void;
  release(key: string): void;
  files: BlobStore;
  newId(): string;
}

const realDeps = (): PhotoDeps => ({
  process: (b) => processPhoto(b),
  flatten: (o, s) => flattenAnnotated(o, s),
  register: registerBlob,
  release: releaseBlob,
  files: getBlobStore(),
  newId: () => crypto.randomUUID().replace(/-/g, "").slice(0, 12),
});

export interface PhotoSidecar {
  blobKey: string;
  width: number;
  height: number;
  shapes: Shape[];
}

export const originalKey = (taskId: string, blobKey: string) => `task-photos/${taskId}/${blobKey}-orig.jpg`;
export const sidecarKey = (taskId: string, blobKey: string) => `task-photos/${taskId}/${blobKey}.json`;

const enc = new TextEncoder();
const dec = new TextDecoder();

async function writeSidecar(files: BlobStore, taskId: string, sc: PhotoSidecar): Promise<void> {
  await files.write(sidecarKey(taskId, sc.blobKey), enc.encode(JSON.stringify(sc)));
}

export async function readSidecar(
  taskId: string,
  blobKey: string,
  files: BlobStore = getBlobStore(),
): Promise<PhotoSidecar | null> {
  const raw = await files.read(sidecarKey(taskId, blobKey));
  if (!raw) return null;
  try {
    return JSON.parse(dec.decode(raw)) as PhotoSidecar;
  } catch {
    return null;
  }
}

async function toPhoto(blobKey: string, blob: Blob): Promise<ComposePhoto> {
  const bytes = await blob.arrayBuffer();
  return { blobKey, sha256: await sha256Hex(bytes), size: blob.size, mime: blob.type || "image/jpeg" };
}

/** Downscale + compress a capture and store it (flattened copy + original). */
export async function addPhoto(taskId: string, source: Blob, deps: PhotoDeps = realDeps()): Promise<ComposePhoto> {
  const processed = await deps.process(source);
  const blobKey = `${taskId}-${deps.newId()}`;
  const photo = await toPhoto(blobKey, processed.blob);
  deps.register(blobKey, processed.blob);
  await deps.files.write(originalKey(taskId, blobKey), new Uint8Array(await source.arrayBuffer()));
  await writeSidecar(deps.files, taskId, { blobKey, width: processed.width, height: processed.height, shapes: [] });
  return photo;
}

/**
 * Re-flatten from the ORIGINAL with new annotation shapes. The flattened bytes
 * change, so the photo gets a new blobKey/sha256; the old copy is released.
 */
export async function applyAnnotations(
  taskId: string,
  photo: ComposePhoto,
  shapes: readonly Shape[],
  deps: PhotoDeps = realDeps(),
): Promise<ComposePhoto> {
  const orig = await deps.files.read(originalKey(taskId, photo.blobKey));
  if (!orig) throw new Error("original photo is missing");
  const original = new Blob([orig as BlobPart], { type: "image/jpeg" });
  const flat = await deps.flatten(original, shapes);
  const blobKey = `${taskId}-${deps.newId()}`;
  const next = await toPhoto(blobKey, flat);
  const prev = await readSidecar(taskId, photo.blobKey, deps.files);
  deps.register(blobKey, flat);
  // move the original + sidecar to the new key, then drop the old ones
  await deps.files.write(originalKey(taskId, blobKey), orig);
  await writeSidecar(deps.files, taskId, {
    blobKey,
    width: prev?.width ?? 0,
    height: prev?.height ?? 0,
    shapes: [...shapes],
  });
  deps.release(photo.blobKey);
  await deps.files.delete(originalKey(taskId, photo.blobKey));
  await deps.files.delete(sidecarKey(taskId, photo.blobKey));
  return next;
}

export async function removePhoto(taskId: string, photo: ComposePhoto, deps: PhotoDeps = realDeps()): Promise<void> {
  deps.release(photo.blobKey);
  await deps.files.delete(originalKey(taskId, photo.blobKey));
  await deps.files.delete(sidecarKey(taskId, photo.blobKey));
}

/** Delete every photo file of a discarded draft. */
export async function discardTaskPhotos(taskId: string, files: BlobStore = getBlobStore()): Promise<void> {
  for (const f of await files.list(`task-photos/${taskId}/`)) await files.delete(f.key);
}

export async function loadOriginal(taskId: string, blobKey: string, files: BlobStore = getBlobStore()): Promise<Blob | null> {
  const orig = await files.read(originalKey(taskId, blobKey));
  return orig ? new Blob([orig as BlobPart], { type: "image/jpeg" }) : null;
}

/** Object URL for a queued photo (survives reloads: bytes come from the durable store). */
export async function previewUrl(blobKey: string): Promise<string | null> {
  try {
    const blob = await getTaskBlobStore().get(blobKey);
    return blob ? URL.createObjectURL(blob) : null;
  } catch {
    return null;
  }
}
