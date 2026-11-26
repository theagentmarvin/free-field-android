import { useState } from "react";
import { MAX_NAME, MAX_VIEWS_PER_BUILDING, type SavedView } from "./viewpoints";

interface Props {
  views: readonly SavedView[];
  /** suggested name for the next view */
  suggestion: string;
  disabled: boolean;
  /** shown under the list: what the last restore could not do */
  note: string | null;
  onSave: (name: string) => void;
  onRestore: (v: SavedView) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}

const when = (t: number) => new Date(t).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/**
 * Saved views of this building: save the camera with the filters, section and hidden elements under a name, tap a row to
 * fly back to it, rename or delete it. Everything is stored on the device (and synced like the web's views).
 */
export function ViewsPanel({ views, suggestion, disabled, note, onSave, onRestore, onRename, onDelete, onClose }: Props) {
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const full = views.filter((v) => !v.fromWeb).length >= MAX_VIEWS_PER_BUILDING;
  const save = () => {
    onSave(name.trim() || suggestion);
    setName("");
  };
  return (
    <aside className="model-sheet tool-panel views-panel" data-testid="views-panel" aria-label="Saved views" data-count={views.length}>
      <header className="model-sheet-head">
        <strong className="grow">Saved views</strong>
        <button type="button" className="btn small" data-testid="views-close" aria-label="Close saved views" onClick={onClose}>
          ✕
        </button>
      </header>
      <div className="model-sheet-body">
        <div className="views-save">
          <input className="field grow" data-testid="views-name" aria-label="Name of the new view" placeholder={suggestion} maxLength={MAX_NAME} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !disabled && save()} />
          <button type="button" className="btn primary small" data-testid="views-save" disabled={disabled} onClick={save}>
            Save view
          </button>
        </div>
        <p className="muted small-text">Saves the camera, the level and filters, the section and what is hidden.{full ? ` The oldest view is replaced after ${MAX_VIEWS_PER_BUILDING}.` : ""}</p>
        {views.length === 0 ? (
          <p className="muted" data-testid="views-empty">
            No saved views in this building yet.
          </p>
        ) : (
          <ul className="views-list" data-testid="views-list">
            {views.map((v) => (
              <li key={v.id} className="views-row" data-testid="view-row" data-view-id={v.id} data-view-name={v.name}>
                {editing?.id === v.id ? (
                  <>
                    <input className="field grow" data-testid="view-rename-input" aria-label="New name" maxLength={MAX_NAME} autoFocus value={editing.text} onChange={(e) => setEditing({ id: v.id, text: e.target.value })} />
                    <button
                      type="button"
                      className="btn primary small"
                      data-testid="view-rename-ok"
                      disabled={!editing.text.trim()}
                      onClick={() => {
                        onRename(v.id, editing.text);
                        setEditing(null);
                      }}
                    >
                      OK
                    </button>
                    <button type="button" className="btn small" data-testid="view-rename-cancel" onClick={() => setEditing(null)}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <>
                    <button type="button" className="views-main" data-testid="view-restore" disabled={disabled || !v.blob} onClick={() => onRestore(v)}>
                      <strong>{v.name}</strong>
                      <span className="muted small-text">{v.blob ? `${when(v.createdAt)}${v.fromWeb ? " · from the web" : ""}` : "Cannot be restored"}</span>
                    </button>
                    <button type="button" className="btn small" data-testid="view-rename" aria-label={`Rename ${v.name}`} onClick={() => setEditing({ id: v.id, text: v.name })}>
                      Rename
                    </button>
                    {confirm === v.id ? (
                      <button
                        type="button"
                        className="btn small danger"
                        data-testid="view-delete-confirm"
                        onClick={() => {
                          setConfirm(null);
                          onDelete(v.id);
                        }}
                      >
                        Delete?
                      </button>
                    ) : (
                      <button type="button" className="btn small" data-testid="view-delete" aria-label={`Delete ${v.name}`} onClick={() => setConfirm(v.id)}>
                        Delete
                      </button>
                    )}
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        {note && (
          <p className="muted small-text" data-testid="views-note" role="status">
            {note}
          </p>
        )}
      </div>
    </aside>
  );
}
