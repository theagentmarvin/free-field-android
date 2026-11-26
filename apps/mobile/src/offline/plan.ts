import type { IfcFileRecord, IfcVersionRecord, PdfFileRecord, PdfVersionRecord } from "@ff/types";
import type { OfflineItem, OfflinePackage, PackageSummary, PlanItem } from "./types";

export interface PlanRows {
  ifcFiles: IfcFileRecord[];
  ifcVersions: IfcVersionRecord[];
  pdfFiles: PdfFileRecord[];
  pdfVersions: PdfVersionRecord[];
}

const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_");

/** BlobStore key of a model file (same convention the Model tab reads). */
export const fragKey = (fragBlobKey: string, versionId: string) => `frag/${safe(fragBlobKey || versionId)}.frag`;
export const pdfKey = (blobKey: string, versionId: string) => `pdf/${safe(blobKey || versionId)}.pdf`;

/**
 * What a building needs offline: for each model file the newest version that HAS a `.frag` (versions with
 * `fragStoragePath == null` are skipped), for each plan EVERY PDF version (revision history and compare work offline).
 * IFC is never included (SPEC A5b).
 */
export function buildPlan(rows: PlanRows): PlanItem[] {
  const out: PlanItem[] = [];
  for (const file of rows.ifcFiles) {
    const candidates = rows.ifcVersions
      .filter((v) => v.ifcFileId === file.id && v.fragStoragePath && v.fragSha256 && typeof v.fragSizeBytes === "number")
      .sort((a, b) => b.versionNumber - a.versionNumber);
    const v = candidates[0];
    if (!v) continue;
    out.push({
      id: `frag:${v.id}`,
      kind: "frag",
      fileId: file.id,
      fileName: file.name,
      versionId: v.id,
      versionNumber: v.versionNumber,
      storagePath: v.fragStoragePath!,
      sha256: v.fragSha256!,
      size: v.fragSizeBytes!,
      key: fragKey(v.fragBlobKey, v.id),
    });
  }
  // Every synced revision of a plan goes into the package, newest first per file, so that the revision
  // history and the compare view work offline. The newest revision of every file is queued before any older
  // one: a plan is usable as soon as its latest version is on the device.
  const older: PlanItem[] = [];
  for (const file of rows.pdfFiles) {
    const versions = rows.pdfVersions
      .filter((x) => x.pdfFileId === file.id && x.storagePath && x.sha256 && typeof x.sizeBytes === "number")
      .sort((a, b) => b.versionNumber - a.versionNumber);
    versions.forEach((v, i) => {
      const item: PlanItem = {
        id: `pdf:${v.id}`,
        kind: "pdf",
        fileId: file.id,
        fileName: file.name,
        versionId: v.id,
        versionNumber: v.versionNumber,
        storagePath: v.storagePath!,
        sha256: v.sha256!,
        size: v.sizeBytes!,
        key: pdfKey(v.blobKey, v.id),
      };
      (i === 0 ? out : older).push(item);
    });
  }
  out.push(...older);
  return out;
}

export function estimateBytes(items: PlanItem[]): number {
  return items.reduce((n, i) => n + i.size, 0);
}

/** Items of the current plan that are not yet downloaded (new file or newer version). */
export function pendingUpdates(plan: PlanItem[], items: OfflineItem[]): PlanItem[] {
  const done = new Set(items.filter((i) => i.status === "done").map((i) => i.id));
  return plan.filter((p) => !done.has(p.id));
}

/** Journal items no longer part of the plan (superseded versions): their files can be removed. */
export function supersededItems(plan: PlanItem[], items: OfflineItem[]): OfflineItem[] {
  const ids = new Set(plan.map((p) => p.id));
  return items.filter((i) => !ids.has(i.id));
}

export function summarize(pkg: OfflinePackage | undefined, items: OfflineItem[]): PackageSummary {
  const totalBytes = items.reduce((n, i) => n + i.size, 0);
  const doneBytes = items.reduce((n, i) => n + (i.status === "done" ? i.size : Math.min(i.bytesDone, i.size)), 0);
  const doneItems = items.filter((i) => i.status === "done").length;
  const errorItems = items.filter((i) => i.status === "error").length;
  let state: PackageSummary["state"] = "none";
  if (pkg) {
    if (items.some((i) => i.status === "downloading" || i.status === "verifying")) state = "downloading";
    else if (pkg.pausedBy && doneItems < items.length) state = "paused";
    else if (errorItems > 0) state = "error";
    else if (items.length > 0 && doneItems === items.length) state = pkg.updateAvailable ? "update-available" : "ready";
    else if (pkg.updateAvailable && doneItems > 0) state = "update-available";
    else state = items.length ? "downloading" : "none"; // queued
  }
  return {
    state,
    doneBytes,
    totalBytes,
    doneItems,
    totalItems: items.length,
    errorItems,
    fraction: totalBytes > 0 ? doneBytes / totalBytes : 0,
  };
}
