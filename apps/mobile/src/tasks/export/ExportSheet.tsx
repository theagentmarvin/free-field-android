import { useEffect, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
import type { TaskTableRow } from "@ff/tasks-react";
import { FfmFiles } from "../../storage/ffmFiles";
import { Sheet } from "../ui";
import { defaultBackend, pruneExports, saveToDownloads, shareExport, type ExportFile } from "./exportFiles";
import { FORMAT_LABELS, runExport, type ExportEnv, type ExportFormat, type ExportProgress, type ExportResult } from "./exportRun";
import { isAbort } from "./reportPdf";
import { useExportEnv } from "./useExportEnv";
import { useIsTablet } from "../../platform/useBreakpoint";

/**
 * Export dialog: pick a format, run it with progress and Cancel, then Share or Save to Downloads. The work is chunked (see
 * exportRun) so a 500-task report does not hold the data in memory; closing the dialog while it runs cancels it.
 */

export interface ExportSheetProps {
  rows: readonly TaskTableRow[];
  /** "Selected tasks" / "Current view" / "This task" */
  scopeLabel: string;
  totalInView?: number;
  getEnv(): ExportEnv | null;
  onClose(): void;
  side?: boolean;
  /** formats offered (a single task has no use for the spreadsheet) */
  formats?: readonly ExportFormat[];
}

const PHOTO_CHOICES = [0, 2, 4] as const;
const ALL_FORMATS: readonly ExportFormat[] = ["pdf", "csv", "bcf21", "bcf30"];

type Phase = { kind: "idle" } | { kind: "running"; progress: ExportProgress } | { kind: "done"; result: ExportResult } | { kind: "cancelled" } | { kind: "error"; message: string };

export function progressLabel(p: ExportProgress): string {
  const what = p.phase === "prepare" ? "Preparing" : p.phase === "build" ? "Building" : "Writing file";
  return p.total > 0 && p.phase !== "prepare" ? `${what}: ${p.done} of ${p.total}` : `${what}...`;
}

export function ExportSheet({ rows, scopeLabel, totalInView, getEnv, onClose, side, formats = ALL_FORMATS }: ExportSheetProps) {
  const [format, setFormat] = useState<ExportFormat>(formats[0] ?? "pdf");
  const [photos, setPhotos] = useState<number>(rows.length > 100 ? 2 : 4);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [saved, setSaved] = useState<string | null>(null);
  const [shareNote, setShareNote] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => () => abort.current?.abort(), []);

  const start = async (): Promise<void> => {
    const env = getEnv();
    if (!env) {
      setPhase({ kind: "error", message: "Choose a project first." });
      return;
    }
    const ac = new AbortController();
    abort.current = ac;
    setSaved(null);
    setShareNote(null);
    setPhase({ kind: "running", progress: { phase: "prepare", done: 0, total: rows.length } });
    if (Capacitor.isNativePlatform()) void FfmFiles.keepAwake({ on: true }).catch(() => undefined);
    try {
      await pruneExports();
      const result = await runExport({ format, rows, totalInView, photosPerTask: photos }, env, defaultBackend(), {
        signal: ac.signal,
        onProgress: (progress) => setPhase((cur) => (cur.kind === "running" ? { kind: "running", progress } : cur)),
      });
      setPhase({ kind: "done", result });
    } catch (e) {
      setPhase(isAbort(e) ? { kind: "cancelled" } : { kind: "error", message: (e as Error).message || "Export failed" });
    } finally {
      abort.current = null;
      if (Capacitor.isNativePlatform()) void FfmFiles.keepAwake({ on: false }).catch(() => undefined);
    }
  };

  const close = (): void => {
    abort.current?.abort();
    onClose();
  };
  const file: ExportFile | null = phase.kind === "done" ? phase.result.file : null;

  const share = async (): Promise<void> => {
    if (!file) return;
    setShareNote(null);
    try {
      if (!(await shareExport(file))) setShareNote("Sharing is not available on this device. Use Save to Downloads.");
    } catch (e) {
      setShareNote((e as Error).message);
    }
  };
  const save = async (): Promise<void> => {
    if (!file) return;
    try {
      const r = await saveToDownloads(file);
      setSaved(`Saved to ${r.where}`);
    } catch (e) {
      setSaved(null);
      setShareNote((e as Error).message);
    }
  };

  return (
    <Sheet title={rows.length === 1 ? "Export task" : "Export tasks"} onClose={close} testId="export-sheet" side={side}>
      <div className="export" data-testid="export-body" data-state={phase.kind}>
        <p className="muted" data-testid="export-scope">
          {scopeLabel}: {rows.length} task{rows.length === 1 ? "" : "s"}
        </p>
        {(phase.kind === "idle" || phase.kind === "cancelled" || phase.kind === "error") && (
          <>
            <div className="chips" role="radiogroup" aria-label="Format">
              {formats.map((f) => (
                <button key={f} type="button" role="radio" aria-checked={format === f} className={`chip${format === f ? " is-on" : ""}`} data-testid={`export-format-${f}`} onClick={() => setFormat(f)}>
                  {FORMAT_LABELS[f]}
                </button>
              ))}
            </div>
            {format === "pdf" && (
              <>
                <p className="muted tiny">Title page, then one block per task: fields, location snapshots, photos and comments. Photos are scaled down to keep the file small.</p>
                <div className="chips" role="radiogroup" aria-label="Photos per task">
                  <span className="muted export-label">Photos per task</span>
                  {PHOTO_CHOICES.map((n) => (
                    <button key={n} type="button" role="radio" aria-checked={photos === n} className={`chip${photos === n ? " is-on" : ""}`} data-testid={`export-photos-${n}`} onClick={() => setPhotos(n)}>
                      {n === 0 ? "None" : `Up to ${n}`}
                    </button>
                  ))}
                </div>
              </>
            )}
            {(format === "bcf21" || format === "bcf30") && <p className="muted tiny">Topics with snapshots, photos and comments. Linked 3D elements and cameras are not included from the tablet. Up to 500 tasks per file.</p>}
            {phase.kind === "cancelled" && (
              <p className="notice" role="status" data-testid="export-cancelled">
                Export cancelled. Nothing was kept.
              </p>
            )}
            {phase.kind === "error" && (
              <p className="error" role="alert" data-testid="export-error">
                {phase.message}
              </p>
            )}
            <div className="sheet-actions">
              <button type="button" className="btn primary" data-testid="export-start" disabled={rows.length === 0} onClick={() => void start()}>
                Create {FORMAT_LABELS[format]}
              </button>
            </div>
          </>
        )}
        {phase.kind === "running" && (
          <>
            <div
              className="progress"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={phase.progress.total}
              aria-valuenow={phase.progress.done}
              data-testid="export-progress"
              data-phase={phase.progress.phase}
              data-done={phase.progress.done}
              data-total={phase.progress.total}
            >
              <div className="progress-fill" style={{ width: `${phase.progress.total > 0 ? Math.round((100 * phase.progress.done) / phase.progress.total) : 0}%` }} />
            </div>
            <p className="muted" data-testid="export-progress-text">
              {progressLabel(phase.progress)}
            </p>
            <div className="sheet-actions">
              <button type="button" className="btn danger" data-testid="export-cancel" onClick={() => abort.current?.abort()}>
                Cancel
              </button>
            </div>
          </>
        )}
        {phase.kind === "done" && file && (
          <>
            <p data-testid="export-result" data-file={file.name} data-size={file.size} data-count={phase.result.count} data-pages={phase.result.pages ?? ""}>
              {phase.result.message}
            </p>
            <p className="muted tiny" data-testid="export-file">
              {file.name} ({formatBytes(file.size)})
            </p>
            {phase.result.notes.map((n) => (
              <p key={n} className="notice" data-testid="export-note">
                {n}
              </p>
            ))}
            <div className="sheet-actions">
              <button type="button" className="btn primary" data-testid="export-share" onClick={() => void share()}>
                Share
              </button>
              <button type="button" className="btn" data-testid="export-save" onClick={() => void save()}>
                Save to Downloads
              </button>
            </div>
            {saved && (
              <p className="muted" role="status" data-testid="export-saved">
                {saved}
              </p>
            )}
            {shareNote && (
              <p className="error" role="alert" data-testid="export-share-note">
                {shareNote}
              </p>
            )}
          </>
        )}
      </div>
    </Sheet>
  );
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** The dialog wired to the live app state; mounted only while open, so the list and detail screens carry no export hooks. */
export function ConnectedExportSheet({ note, ...props }: Omit<ExportSheetProps, "getEnv"> & { note: () => string }) {
  const getEnv = useExportEnv(note);
  const tablet = useIsTablet();
  return <ExportSheet {...props} getEnv={getEnv} side={tablet} />;
}
