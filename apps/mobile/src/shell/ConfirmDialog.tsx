import type { ReactNode } from "react";

export interface ConfirmDialogProps {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  testId?: string;
}

/** Modal confirm (window.confirm is unreliable in a WebView and untestable). */
export function ConfirmDialog(p: ConfirmDialogProps) {
  return (
    <div className="scrim" role="presentation" onClick={p.onCancel}>
      <div
        className="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-label={p.title}
        data-testid={p.testId ?? "confirm-dialog"}
        onClick={(e) => e.stopPropagation()}
      >
        <h2>{p.title}</h2>
        <div className="dialog-body">{p.children}</div>
        <div className="dialog-actions">
          <button className="btn" data-testid="confirm-cancel" onClick={p.onCancel}>
            Cancel
          </button>
          <button className={`btn ${p.danger ? "danger" : "primary"}`} data-testid="confirm-ok" onClick={p.onConfirm}>
            {p.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
