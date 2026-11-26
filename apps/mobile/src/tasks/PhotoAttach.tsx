import { useEffect, useState } from "react";
import type { ComposePhoto } from "@ff/tasks-react";
import { capturePhoto, type CaptureSource, DENIED_MESSAGE, describePhotoError } from "./camera";
import { AnnotationEditor } from "./annotate/AnnotationEditor";
import type { Shape } from "./annotate/model";
import { FfmFiles } from "../storage/ffmFiles";
import { addPhoto, applyAnnotations, loadOriginal, previewUrl, readSidecar, removePhoto } from "./photoStore";

/**
 * Photo strip for the compose form and the comment box: capture/pick, show
 * thumbnails, annotate, remove. Photos are processed and stored by
 * `photoStore`; this component only holds the list.
 */
export function PhotoAttach({
  taskId,
  photos,
  onChange,
  beforeCapture,
}: {
  taskId: string;
  photos: ComposePhoto[];
  onChange(next: ComposePhoto[]): void;
  /** called before the camera/gallery launches (the form saves its draft here) */
  beforeCapture?: () => Promise<void> | void;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ photo: ComposePhoto; original: Blob; shapes: Shape[] } | null>(null);

  async function add(source: CaptureSource) {
    setMessage(null);
    setBusy(true);
    try {
      await beforeCapture?.();
      const res = await capturePhoto(source, taskId);
      if (!res.ok) {
        if (res.reason !== "cancelled") setMessage(res.message ?? "Could not get the photo.");
        return;
      }
      onChange([...photos, await addPhoto(taskId, res.blob)]);
    } catch (e) {
      setMessage(describePhotoError(e));
    } finally {
      setBusy(false);
    }
  }

  async function openEditor(photo: ComposePhoto) {
    const original = await loadOriginal(taskId, photo.blobKey);
    if (!original) {
      setMessage("The original photo is no longer on this device, so it cannot be annotated.");
      return;
    }
    const sc = await readSidecar(taskId, photo.blobKey);
    setEditing({ photo, original, shapes: sc?.shapes ?? [] });
  }

  async function finishEdit(shapes: Shape[]) {
    if (!editing) return;
    const target = editing;
    setEditing(null);
    setBusy(true);
    try {
      const next = await applyAnnotations(taskId, target.photo, shapes);
      onChange(photos.map((p) => (p.blobKey === target.photo.blobKey ? next : p)));
    } catch (e) {
      setMessage(`Could not save the annotations: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function remove(photo: ComposePhoto) {
    onChange(photos.filter((p) => p.blobKey !== photo.blobKey));
    await removePhoto(taskId, photo).catch(() => undefined);
  }

  return (
    <div className="photo-attach" data-testid="photo-attach">
      <div className="photo-grid">
        {photos.map((p) => (
          <PhotoTile key={p.blobKey} photo={p} onAnnotate={() => void openEditor(p)} onRemove={() => void remove(p)} />
        ))}
      </div>
      <div className="photo-actions">
        <button type="button" className="btn" data-testid="photo-camera" disabled={busy} onClick={() => void add("camera")}>
          Take photo
        </button>
        <button type="button" className="btn" data-testid="photo-gallery" disabled={busy} onClick={() => void add("gallery")}>
          From gallery
        </button>
        {busy && <span className="muted" data-testid="photo-busy">Working...</span>}
      </div>
      {message && (
        <p className="notice" role="alert" data-testid="photo-message" data-denied={message === DENIED_MESSAGE ? "1" : "0"}>
          {message}
          {message === DENIED_MESSAGE && (
            <>
              {" "}
              <button type="button" className="btn small" data-testid="photo-open-settings" onClick={() => void FfmFiles.openAppSettings().catch(() => undefined)}>
                Open settings
              </button>
            </>
          )}
        </p>
      )}
      {editing && (
        <AnnotationEditor
          original={editing.original}
          initialShapes={editing.shapes}
          onCancel={() => setEditing(null)}
          onDone={(s) => void finishEdit(s)}
        />
      )}
    </div>
  );
}

function PhotoTile({ photo, onAnnotate, onRemove }: { photo: ComposePhoto; onAnnotate(): void; onRemove(): void }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    let made: string | null = null;
    void previewUrl(photo.blobKey).then((u) => {
      made = u;
      if (live) setUrl(u);
      else if (u) URL.revokeObjectURL(u);
    });
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [photo.blobKey]);
  return (
    <div className="photo-tile" data-testid="photo-tile" data-blob={photo.blobKey}>
      <button type="button" className="thumb" onClick={onAnnotate} aria-label="Annotate photo" data-testid="photo-annotate">
        {url ? <img src={url} alt="Attached photo" /> : <span className="muted">Photo</span>}
      </button>
      <button type="button" className="tile-remove" aria-label="Remove photo" data-testid="photo-remove" onClick={onRemove}>
        x
      </button>
    </div>
  );
}
