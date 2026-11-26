import type { TaskEntry } from "@ff/firestore";
import { exportBcf, type BcfBinary, type BcfVersion, type TaskEntryView } from "@ff/tasks";
import {
  BCF_MAX_TOPICS,
  bcfCapMessage,
  bcfDoneMessage,
  buildBcfBundles,
  buildBcfUserDirectory,
  buildCsv,
  convertToPng,
  exportFileName,
  firstValue,
  selectBcfScope,
  type BcfPerson,
  type TasksSource,
  type TaskTableRow,
} from "@ff/tasks-react";
import { downscaleToJpeg, makeImageLoader, readRefBlob, type ImageSources } from "./imageLoader";
import { indexPendingPhotos, type PendingPhotoIndex } from "./pendingPhotos";
import { buildReportBlock, buildReportMeta, blobRef, fmtDay, type ReportBlock, type ReportInputEntry } from "./reportModel";
import { abortError, isAbort, renderReport } from "./reportPdf";
import { MIME, pipeBlob, pipeText, type ExportFile, type FileBackend } from "./exportFiles";

export type ExportFormat = "pdf" | "csv" | "bcf21" | "bcf30";

export const FORMAT_LABELS: Record<ExportFormat, string> = {
  pdf: "PDF report",
  csv: "CSV (spreadsheet)",
  bcf21: "BCF 2.1",
  bcf30: "BCF 3.0",
};

/** Largest edge of a report photo, in pixels. A4 at four photos across needs far fewer than the 2560 px a capture keeps. */
export const REPORT_PHOTO_SIDE = 800;
/** Cap on image bytes embedded in one PDF, so a 500-task report stays shareable. */
export const REPORT_IMAGE_BUDGET = 90 * 1024 * 1024;
/** Photo budget of one BCF file (the web allows 250 MB; the tablet builds the zip in memory). */
export const BCF_PHOTO_BUDGET = 60 * 1024 * 1024;
export const BCF_PHOTO_SIDE = 1280;
/** One-shot reads from the local task cache; a task that only exists in the outbox never answers. */
export const READ_TIMEOUT_MS = 1500;
export const CSV_BATCH = 250;

export interface ExportEnv {
  projectId: string;
  projectName: string;
  actorName: string;
  filterNote: string;
  source: Pick<TasksSource, "watchTask" | "watchTaskEntries">;
  /** timeline of one task: cloud entries merged with queued ones */
  loadEntries(taskId: string): Promise<TaskEntryView[]>;
  pending(): PendingPhotoIndex;
  images: ImageSources;
  sheetNames?(): Promise<ReadonlyMap<string, { name: string }> | null>;
  people?(): Promise<BcfPerson[]>;
}

export interface ExportRequest {
  format: ExportFormat;
  rows: readonly TaskTableRow[];
  /** rows in the view when the request is a subset (selection) */
  totalInView?: number;
  /** task photos per task in the PDF (0 = none) */
  photosPerTask: number;
}

export interface ExportProgress {
  phase: "prepare" | "build" | "write";
  done: number;
  total: number;
}

export interface ExportOptions {
  signal?: AbortSignal;
  onProgress?(p: ExportProgress): void;
  now?(): number;
  yieldFn?(): Promise<void>;
}

export interface ExportResult {
  file: ExportFile;
  count: number;
  /** warnings shown under the result (missing images, caps) */
  notes: string[];
  message: string;
  pages?: number;
}

const stamp = (now: number): string => {
  const d = new Date(now);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${fmtDay(now)}-${p(d.getHours())}${p(d.getMinutes())}`;
};

/** Entries as the report wants them: queued photos come from the outbox index, cloud ones from the entry itself. */
export function toReportEntries(entries: readonly TaskEntryView[], idx: PendingPhotoIndex): ReportInputEntry[] {
  return entries.map((e) => {
    const paths = e.pending ? (idx.byGuid.get(e.clientGuid) ?? []) : (e.photos ?? []).map((p) => p.storagePath);
    const caps = new Map((e.photos ?? []).map((p) => [p.storagePath, p.caption ?? null]));
    return {
      action: e.action,
      by: e.by,
      at: e.at,
      statusFrom: e.statusFrom,
      statusTo: e.statusTo,
      text: e.text,
      pending: e.pending,
      failed: e.failed,
      photos: paths.map((p) => ({ ref: idx.pendingKeys.has(p) ? blobRef(idx.pendingKeys.get(p)!) : p, caption: caps.get(p) ?? null })),
    };
  });
}

export async function* reportBlocks(rows: readonly TaskTableRow[], env: ExportEnv, photosPerTask: number, now: number, signal?: AbortSignal): AsyncGenerator<ReportBlock> {
  const idx = env.pending();
  for (const row of rows) {
    if (signal?.aborted) throw abortError();
    const entries = await env.loadEntries(row.id).catch(() => [] as TaskEntryView[]);
    const photos = (row.photos ?? []).map((p) => ({
      ref: idx.pendingKeys.has(p.storagePath) ? blobRef(idx.pendingKeys.get(p.storagePath)!) : p.storagePath,
      caption: (p as { caption?: string | null }).caption ?? null,
    }));
    yield buildReportBlock({ row, entries: toReportEntries(entries, idx), photos }, { now, maxPhotos: photosPerTask, maxEntryPhotos: photosPerTask > 0 ? 2 : 0 });
  }
}

/** CSV in batches: header once, the rest appended per batch. Joined, it equals `buildCsv(rows)`. */
export function* csvBatches(rows: readonly TaskTableRow[], now: number, batch = CSV_BATCH): Generator<string> {
  if (rows.length === 0) {
    yield buildCsv([], now);
    return;
  }
  for (let i = 0; i < rows.length; i += batch) {
    const text = buildCsv(rows.slice(i, i + batch), now);
    if (i === 0) yield text;
    else yield text.slice(text.indexOf("\r\n") + 2);
  }
}

export async function runExport(req: ExportRequest, env: ExportEnv, backend: FileBackend, opts: ExportOptions = {}): Promise<ExportResult> {
  const now = (opts.now ?? Date.now)();
  const { signal } = opts;
  const total = req.rows.length;
  const progress = (phase: ExportProgress["phase"], done: number, tot = total): void => opts.onProgress?.({ phase, done, total: tot });
  const check = (): void => {
    if (signal?.aborted) throw abortError();
  };
  check();
  progress("prepare", 0);

  if (req.format === "csv") {
    const name = exportFileName("freefield-tasks", "csv", now);
    const sink = await backend.create(name, MIME.csv!);
    try {
      let done = 0;
      for (const part of csvBatches(req.rows, now)) {
        check();
        await pipeText(part, sink);
        done = Math.min(total, done + CSV_BATCH);
        progress("write", done);
        await (opts.yieldFn ?? (() => new Promise<void>((r) => setTimeout(r, 0))))();
      }
      const file = await sink.close();
      return { file, count: total, notes: [], message: `Exported ${total} task${total === 1 ? "" : "s"} to CSV` };
    } catch (e) {
      await sink.abort();
      throw e;
    }
  }

  if (req.format === "pdf") {
    const name = `freefield-task-report-${stamp(now)}.pdf`;
    const meta = buildReportMeta(req.rows, { projectName: env.projectName, filterNote: env.filterNote, printedBy: env.actorName, now, totalInView: req.totalInView });
    const sink = await backend.create(name, MIME.pdf!);
    try {
      const res = await renderReport(sink, reportBlocks(req.rows, env, req.photosPerTask, now, signal), meta, makeImageLoader(env.images, signal), {
        signal,
        photoMaxSide: REPORT_PHOTO_SIDE,
        maxImageBytes: REPORT_IMAGE_BUDGET,
        yieldFn: opts.yieldFn,
        onProgress: (d, t) => progress("build", d, t),
      });
      const file = await sink.close();
      const notes: string[] = [];
      if (res.imagesMissing > 0) notes.push(`${res.imagesMissing} image${res.imagesMissing === 1 ? " is" : "s are"} not on this device yet and were left out`);
      if (res.imagesOverBudget > 0) notes.push(`size limit reached: ${res.imagesOverBudget} image${res.imagesOverBudget === 1 ? "" : "s"} left out`);
      return {
        file,
        count: res.tasks,
        notes,
        pages: res.pages,
        message: `Report ready: ${res.tasks} task${res.tasks === 1 ? "" : "s"}, ${res.pages} page${res.pages === 1 ? "" : "s"}`,
      };
    } catch (e) {
      await sink.abort();
      throw e;
    }
  }

  // BCF
  const version: BcfVersion = req.format === "bcf21" ? "2.1" : "3.0";
  const scope = selectBcfScope([], req.rows);
  const fetchBinary = async (path: string, o: { mime?: string; measure?: boolean }): Promise<BcfBinary | null> => {
    check();
    const blob = await readRefBlob(path, env.images);
    if (!blob) return null;
    const img = await downscaleToJpeg(blob, o.measure ? 1500 : BCF_PHOTO_SIDE, 0.8);
    return img ? { bytes: img.bytes, mime: "image/jpeg", width: img.width, height: img.height } : null;
  };
  const sheets = await env.sheetNames?.().catch(() => null);
  const built = await buildBcfBundles(scope.rows, {
    projectId: env.projectId,
    source: env.source,
    fetchBinary,
    sheetName: (id) => sheets?.get(id)?.name,
    maxPhotoBytes: BCF_PHOTO_BUDGET,
    timeoutMs: READ_TIMEOUT_MS,
    onProgress: (d, n) => {
      check(); // throwing here stops the build between tasks
      progress("build", d, n);
    },
  });
  check();
  const people: BcfPerson[] = [...((await env.people?.().catch(() => [])) ?? []), { uid: "", name: env.actorName }];
  progress("write", 0, 1);
  const result = await exportBcf(built.bundles, {
    version,
    project: { id: env.projectId, name: env.projectName },
    users: buildBcfUserDirectory(people.filter((p) => p.uid || p.name)),
    baseShift: (taskId) => built.shifts.get(taskId) ?? null,
    convertToPng,
    now: () => now,
  });
  check();
  const sink = await backend.create(result.filename, MIME.bcf!);
  try {
    await pipeBlob(result.blob, sink);
    const file = await sink.close();
    progress("write", 1, 1);
    const notes: string[] = [];
    if (scope.capped) notes.push(bcfCapMessage(scope.total, BCF_MAX_TOPICS));
    return {
      file,
      count: result.topicCount,
      notes,
      message: bcfDoneMessage(result.topicCount, version, result.warnings, { skipped: built.skippedPhotos, budgetSkipped: built.budgetSkippedPhotos }),
    };
  } catch (e) {
    await sink.abort();
    throw e;
  }
}

export { isAbort };

/** One-shot read of a task's timeline from the local source, merged with queued entries by the caller. */
export function readEntriesOnce(source: ExportEnv["source"], projectId: string, taskId: string): Promise<TaskEntry[]> {
  return firstValue<TaskEntry[]>((cb) => source.watchTaskEntries(projectId, taskId, cb), [], READ_TIMEOUT_MS);
}

export { indexPendingPhotos };
