import {
  checklistProgress,
  isDualThumbLocation,
  normalizeChecklist,
  normalizeLocationThumb2dPath,
  normalizeLocationThumbPath,
  PRIORITY_LABELS,
  priorityOf,
  type TaskEntryView,
} from "@ff/tasks";
import { deadlineSignal, formatTaskNum, STATUS_LABELS, REPORT_MAX_PHOTOS, type TaskTableRow } from "@ff/tasks-react";

/**
 * Report content, assembled as plain data (no layout, no I/O) so it is unit-testable. Content and ordering follow the web's
 * task report: title block (number, title, status), description, field grid, location snapshots (plan first, then 3D), photos,
 * then the timeline of comments and status changes. The PDF layout in `reportPdf.ts` only draws these blocks.
 */

/** Image reference: a storage path, or `blob:<blobKey>` for a photo still waiting in the outbox. */
export type ImageRef = string;
export const blobRef = (blobKey: string): ImageRef => `blob:${blobKey}`;
export const isBlobRef = (r: ImageRef): boolean => r.startsWith("blob:");

export interface ReportInputEntry extends Pick<TaskEntryView, "action" | "by" | "at" | "statusFrom" | "statusTo"> {
  text?: string | null;
  pending?: boolean;
  failed?: boolean;
  /** photo refs, already resolved (storage paths or blob refs) */
  photos: { ref: ImageRef; caption?: string | null }[];
}

export interface ReportInputTask {
  row: TaskTableRow & { description?: string; priority?: string | null; checklist?: unknown; createdAt?: number; updatedAt?: number };
  entries: readonly ReportInputEntry[];
  /** task photo refs (storage paths or blob refs), in order */
  photos: { ref: ImageRef; caption?: string | null }[];
}

export interface ReportEntryBlock {
  who: string;
  title: string;
  when: string;
  transition: string | null;
  state: string | null;
  text: string;
  photos: { ref: ImageRef; caption: string | null }[];
}

export interface ReportBlock {
  taskId: string;
  num: string;
  title: string;
  status: number;
  statusLabel: string;
  description: string;
  fields: { k: string; v: string; flag?: "late" | "soon" }[];
  checklist: { text: string; done: boolean }[];
  /** plan snapshot first (dual location), then the 3D one */
  locationImages: { ref: ImageRef; label: string }[];
  photos: { ref: ImageRef; caption: string | null }[];
  /** photos beyond the per-task limit */
  morePhotos: number;
  entries: ReportEntryBlock[];
}

export const VERB_TITLES: Record<string, string> = {
  create: "Created",
  comment: "Comment",
  edit: "Edit",
  assign: "Assign",
  complete: "Submitted for approval",
  reject: "Rejected",
  approve: "Approved",
  followup: "Approved - follow-up",
  discontinue: "Discontinued",
};

const pad = (n: number): string => String(n).padStart(2, "0");

export function fmtDay(ts: number | null | undefined): string {
  if (typeof ts !== "number" || ts <= 0) return "-";
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function fmtStamp(ts: number | null | undefined): string {
  if (typeof ts !== "number" || ts <= 0) return "-";
  const d = new Date(ts);
  return `${fmtDay(ts)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const statusWord = (s: number | null): string => (s === null ? "queued" : (STATUS_LABELS[s] ?? `status ${s}`));

export interface ReportOptions {
  now: number;
  /** task photos shown per task (the web prints 4) */
  maxPhotos?: number;
  /** comment photos shown per timeline entry */
  maxEntryPhotos?: number;
}

export function buildReportBlock(t: ReportInputTask, opts: ReportOptions): ReportBlock {
  const r = t.row;
  const maxPhotos = opts.maxPhotos ?? REPORT_MAX_PHOTOS;
  const maxEntryPhotos = opts.maxEntryPhotos ?? 2;
  const sig = deadlineSignal(r.deadline, r.status, opts.now);
  const cl = checklistProgress(normalizeChecklist(r.checklist));
  const fields: ReportBlock["fields"] = [
    { k: "Type", v: r.type ? r.type.charAt(0).toUpperCase() + r.type.slice(1) : "Task" },
    { k: "Priority", v: PRIORITY_LABELS[priorityOf(r.priority)] },
    { k: "Assignee", v: r.assigneeName || "-" },
    { k: "Deadline", v: `${fmtDay(r.deadline)}${sig === "overdue" ? " (overdue)" : sig === "soon" ? " (due soon)" : ""}`, ...(sig === "overdue" ? { flag: "late" as const } : sig === "soon" ? { flag: "soon" as const } : {}) },
    { k: "Building / level", v: [r.buildingName ?? r.buildingId, r.storeyName].filter(Boolean).join(" / ") || "-" },
  ];
  if (cl.total > 0) fields.push({ k: "Checklist", v: `${cl.done}/${cl.total} done` });
  const loc = (r.location ?? null) as { text?: string; bim?: unknown; pdf?: { page?: number } | null } | null;
  const pins: string[] = [];
  if (loc?.bim) pins.push("3D pin");
  if (loc?.pdf) pins.push(`plan pin, page ${loc.pdf.page ?? 1}`);
  if (loc?.text || pins.length) fields.push({ k: "Location", v: [loc?.text, pins.join(", ")].filter(Boolean).join(" - ") });
  fields.push({ k: "Created by", v: `${r.createdBy || "-"} - ${fmtDay(r.createdAt)}` });
  fields.push({ k: "Updated", v: fmtStamp(r.updatedAt) });

  const locationImages: ReportBlock["locationImages"] = [];
  if (isDualThumbLocation(r.location)) {
    const p2 = normalizeLocationThumb2dPath(r.location);
    if (p2) locationImages.push({ ref: p2, label: "Plan snapshot" });
  }
  const thumb3d = r.locationThumbPath ?? normalizeLocationThumbPath(r.location);
  if (thumb3d) locationImages.push({ ref: thumb3d, label: "Location snapshot" });

  const entries: ReportEntryBlock[] = t.entries.map((e) => {
    const transition = e.statusFrom !== null && e.statusTo !== null && e.statusFrom !== e.statusTo ? `${statusWord(e.statusFrom)} > ${statusWord(e.statusTo)}` : null;
    // the creation entry repeats the task photos: print them once, in the photo grid
    const photos = e.action === "create" ? [] : e.photos.slice(0, maxEntryPhotos).map((p) => ({ ref: p.ref, caption: p.caption ?? null }));
    return {
      who: e.by || "-",
      title: VERB_TITLES[e.action] ?? e.action,
      when: fmtStamp(e.at),
      transition,
      state: e.pending ? (e.failed ? "failed, retry pending" : "queued, not yet committed") : null,
      text: e.action === "create" ? "" : (e.text ?? ""),
      photos,
    };
  });

  return {
    taskId: r.id,
    num: r.num > 0 ? formatTaskNum(r.num) : "New",
    title: r.title || "(untitled task)",
    status: r.status,
    statusLabel: statusWord(r.status),
    description: r.description ?? "",
    fields,
    checklist: normalizeChecklist(r.checklist).map((c) => ({ text: c.text, done: c.done })),
    locationImages,
    photos: t.photos.slice(0, maxPhotos).map((p) => ({ ref: p.ref, caption: p.caption ?? null })),
    morePhotos: Math.max(0, t.photos.length - maxPhotos),
    entries,
  };
}

export interface ReportMeta {
  projectName: string;
  /** building names the report covers */
  buildings: string[];
  filterNote: string;
  printedBy: string;
  printedAt: string;
  taskCount: number;
  totalInView?: number;
  statusCounts: { label: string; count: number }[];
}

export function buildReportMeta(
  rows: readonly Pick<TaskTableRow, "status" | "buildingName" | "buildingId">[],
  info: { projectName?: string | null; filterNote?: string; printedBy?: string; now: number; totalInView?: number },
): ReportMeta {
  const counts = new Map<number, number>();
  const buildings = new Set<string>();
  for (const r of rows) {
    counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
    const b = r.buildingName ?? r.buildingId;
    if (b) buildings.add(b);
  }
  return {
    projectName: info.projectName?.trim() || "FreeField",
    buildings: [...buildings].sort((a, b) => a.localeCompare(b)),
    filterNote: info.filterNote ?? "Current view",
    printedBy: info.printedBy ?? "",
    printedAt: fmtStamp(info.now),
    taskCount: rows.length,
    ...(info.totalInView !== undefined ? { totalInView: info.totalInView } : {}),
    statusCounts: [...counts.entries()].sort((a, b) => a[0] - b[0]).map(([s, n]) => ({ label: statusWord(s), count: n })),
  };
}
