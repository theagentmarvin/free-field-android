import { useState } from "react";
import type { PhotoUrlResolver } from "@ff/tasks-react";
import { ConfirmDialog } from "../shell/ConfirmDialog";
import { IconTrash } from "../markup/icons";
import { PhotoThumb } from "./ui";
import type { MarkupAttachment } from "./markupAttach";

/** A markup in the attachment list: the picture with a small "Markup" badge so it reads apart from a plain photo. */
export function MarkupThumb({ markup, resolver, blobKey, onOpen }: { markup: Pick<MarkupAttachment, "key" | "path" | "pending" | "failed">; resolver: PhotoUrlResolver | undefined; blobKey?: string; onOpen(url: string): void }) {
  return (
    <div className="markup-thumb" data-testid="task-markup" data-key={markup.key} data-pending={markup.pending ? "1" : "0"}>
      <PhotoThumb storagePath={markup.path} blobKey={blobKey} resolver={resolver} onOpen={onOpen} />
      <span className="markup-badge" data-testid="markup-badge">
        Markup
      </span>
    </div>
  );
}

/**
 * Full-screen view of a saved markup. A markup is a fixed picture: it can be looked at and deleted (after a confirmation),
 * never edited.
 */
export function MarkupViewer({ url, canDelete, onDelete, onClose }: { url: string; canDelete: boolean; onDelete(): Promise<void>; onClose(): void }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await onDelete();
      setConfirm(false);
      onClose();
    } catch (e) {
      setConfirm(false);
      setBusy(false);
      setError(`Could not delete the markup: ${(e as Error).message}`);
    }
  };

  return (
    <div className="markup-viewer" data-testid="markup-viewer" role="dialog" aria-label="Markup">
      <div className="markup-viewer-bar">
        <button type="button" className="btn" data-testid="markup-viewer-close" onClick={onClose}>
          Close
        </button>
        <span className="markup-badge">Markup</span>
        <span className="grow" />
        {canDelete && (
          <button type="button" className="btn danger-text markup-delete" data-testid="markup-delete" disabled={busy} onClick={() => setConfirm(true)}>
            <IconTrash /> Delete
          </button>
        )}
      </div>
      <div className="markup-viewer-stage">
        <img src={url} alt="Markup, full size" data-testid="markup-viewer-image" />
      </div>
      {error && (
        <p className="error markup-viewer-error" role="alert" data-testid="markup-viewer-error">
          {error}
        </p>
      )}
      {confirm && (
        <ConfirmDialog title="Delete this markup?" confirmLabel="Delete" danger onConfirm={() => void remove()} onCancel={() => setConfirm(false)} testId="markup-delete-dialog">
          The markup is removed from this task. This cannot be undone.
        </ConfirmDialog>
      )}
    </div>
  );
}
