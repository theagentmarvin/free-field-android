import { useEffect, useRef, useState, type ReactNode } from "react";
import { STATUS_LABELS, formatTaskNum, usePhotoUrl, type PhotoUrlResolver } from "@ff/tasks-react";
import { initialsOf, statusAccent } from "@ff/tasks-react";

export function StatusChip({ status }: { status: number }) {
  return (
    <span
      className={`status s-${status}`}
      style={{ ["--st" as string]: statusAccent(status).bg }}
      data-testid="status-chip"
      data-status={status}
    >
      {STATUS_LABELS[status] ?? String(status)}
    </span>
  );
}

/** Per-task outbox state: queued (waiting/sending) or failed. */
export function SyncBadge({ pending, failed }: { pending?: boolean; failed?: boolean }) {
  if (failed) {
    return (
      <span className="sync-badge is-failed" data-testid="sync-badge" data-state="failed">
        Failed
      </span>
    );
  }
  if (pending) {
    return (
      <span className="sync-badge is-pending" data-testid="sync-badge" data-state="pending">
        Queued
      </span>
    );
  }
  return null;
}

/** Display number; a task still queued for creation has no server number yet. */
export const numLabel = (num: number): string => (num > 0 ? formatTaskNum(num) : "New");

export function Avatar({ name }: { name: string | null | undefined }) {
  return (
    <span className="avatar" title={name ?? "Unassigned"} aria-label={name ?? "Unassigned"}>
      {name ? initialsOf(name) : "-"}
    </span>
  );
}

const DATE_FMT = new Intl.DateTimeFormat(undefined, { day: "2-digit", month: "short" });
const DATETIME_FMT = new Intl.DateTimeFormat(undefined, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
export const fmtDate = (ts: number): string => DATE_FMT.format(new Date(ts));
export const fmtDateTime = (ts: number): string => DATETIME_FMT.format(new Date(ts));

/** Modal bottom sheet (full-width on phones, centered card on tablets). */
export function Sheet({
  title,
  onClose,
  children,
  testId,
  side,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  testId?: string;
  /** landscape (>= 840 dp): a full-height panel on the right instead of a centered card */
  side?: boolean;
}) {
  return (
    <div className={`sheet-backdrop${side ? " is-side" : ""}`} onClick={onClose} data-testid={testId}>
      <div className="sheet" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h2>{title}</h2>
          <button type="button" className="btn" onClick={onClose} data-testid="sheet-close">
            Done
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Photo thumbnail: a queued blob when we still hold it, else the resolved Storage/demo URL. */
export function PhotoThumb({
  storagePath,
  blobKey,
  resolver,
  onOpen,
}: {
  storagePath: string;
  blobKey?: string;
  resolver: PhotoUrlResolver | undefined;
  onOpen?: (url: string) => void;
}) {
  const remote = usePhotoUrl(resolver, storagePath);
  const [local, setLocal] = useState<string | null>(null);
  useEffect(() => {
    let url: string | null = null;
    let live = true;
    if (!blobKey) {
      setLocal(null);
      return;
    }
    void import("./photoStore").then(async (m) => {
      const u = await m.previewUrl(blobKey);
      if (!live) {
        if (u) URL.revokeObjectURL(u);
        return;
      }
      url = u;
      setLocal(u);
    });
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [blobKey]);
  const src = local ?? remote;
  return (
    <button
      type="button"
      className="thumb"
      data-testid="task-photo"
      disabled={!src}
      onClick={() => src && onOpen?.(src)}
      aria-label="Open photo"
    >
      {src ? <img src={src} alt="Task photo" /> : <span className="muted">Photo</span>}
    </button>
  );
}

export function Lightbox({ url, onClose }: { url: string; onClose: () => void }) {
  return (
    <div className="lightbox" onClick={onClose} data-testid="lightbox">
      <img src={url} alt="Task photo, full size" />
    </div>
  );
}

/**
 * Pull-to-refresh for a scroll container: when scrolled to the top, dragging
 * down past the threshold fires `onRefresh`.
 */
export function usePullToRefresh(onRefresh: () => Promise<void> | void) {
  const ref = useRef<HTMLDivElement>(null);
  const [pull, setPull] = useState(0);
  const [busy, setBusy] = useState(false);
  const start = useRef<number | null>(null);
  const THRESHOLD = 70;

  const handlers = {
    onTouchStart: (e: React.TouchEvent) => {
      const el = ref.current;
      start.current = el && el.scrollTop <= 0 ? e.touches[0].clientY : null;
    },
    onTouchMove: (e: React.TouchEvent) => {
      if (start.current === null || busy) return;
      const dy = e.touches[0].clientY - start.current;
      setPull(dy > 0 ? Math.min(dy * 0.5, 110) : 0);
    },
    onTouchEnd: () => {
      const fire = pull >= THRESHOLD && !busy;
      start.current = null;
      setPull(0);
      if (fire) {
        setBusy(true);
        void Promise.resolve(onRefresh()).finally(() => setTimeout(() => setBusy(false), 600));
      }
    },
  };
  return { ref, pull, busy, handlers };
}
