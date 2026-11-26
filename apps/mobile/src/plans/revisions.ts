import type { PdfVersionRecord } from "@ff/types";
import { latestVersion } from "./planModel";

/** One revision of a plan as the history list shows it. */
export interface RevisionInfo {
  versionId: string;
  /** `PdfVersionRecord.versionNumber` (1, 2, 3...), the number the web shows as "v2". */
  number: number;
  /** Original file name of the upload ("PLUMBING 2.pdf"). */
  name: string;
  /** When the revision was stored (epoch ms). */
  storedAt: number;
  isLatest: boolean;
  /** The PDF is on the device (always true in demo mode). */
  onDevice: boolean;
}

/** Every synced revision of a plan, newest first. `onDevice` null = everything counts as on the device (demo). */
export function listRevisions(versions: readonly PdfVersionRecord[], onDevice: ReadonlySet<string> | null): RevisionInfo[] {
  const latest = latestVersion(versions);
  return [...versions]
    .sort((a, b) => b.versionNumber - a.versionNumber)
    .map((v) => ({
      versionId: v.id,
      number: v.versionNumber,
      name: v.name,
      storedAt: v.storedAt,
      isLatest: v.id === latest?.id,
      onDevice: onDevice ? onDevice.has(v.id) : true,
    }));
}

/** "Revision 1 of 2": the position of a revision in its plan's history. */
export function revisionPosition(versions: readonly PdfVersionRecord[], versionId: string): { number: number; total: number; isLatest: boolean } | null {
  const v = versions.find((x) => x.id === versionId);
  if (!v) return null;
  return { number: v.versionNumber, total: versions.length, isLatest: latestVersion(versions)?.id === versionId };
}

export function revisionTitle(pos: { number: number; total: number; isLatest: boolean }): string {
  return pos.isLatest ? `Revision ${pos.number} of ${pos.total} (latest)` : `Revision ${pos.number} of ${pos.total}, not the latest`;
}

/** "2 revisions" for the plans list; null when the plan has a single version. */
export function revisionsBadge(count: number): string | null {
  return count > 1 ? `${count} revisions` : null;
}

/**
 * Where a pin was placed, relative to the revision on screen:
 *  - `current`: on the displayed revision
 *  - `earlier`: on another known revision (`number` is its revision number)
 *  - `unknown`: names a version that no longer exists (deleted) or the task predates version stamping (`legacy`)
 */
export type PinRevision = { kind: "current" } | { kind: "earlier"; number: number; versionId: string } | { kind: "unknown"; legacy: boolean };

export function pinRevision(pdfVersionId: string | undefined, displayedVersionId: string, versions: readonly PdfVersionRecord[]): PinRevision {
  if (pdfVersionId === displayedVersionId) return { kind: "current" };
  if (!pdfVersionId) return { kind: "unknown", legacy: true };
  const v = versions.find((x) => x.id === pdfVersionId);
  return v ? { kind: "earlier", number: v.versionNumber, versionId: v.id } : { kind: "unknown", legacy: false };
}

/** Short badge on a pin of another revision ("R1"), null otherwise. */
export const pinRevisionBadge = (r: PinRevision): string | null => (r.kind === "earlier" ? `R${r.number}` : null);

/** Default pair for Compare: the revision before the newest one against the newest one. */
export function defaultComparePair(revs: readonly RevisionInfo[], current?: string): { base: string; revision: string } | null {
  const usable = revs.filter((r) => r.onDevice);
  if (usable.length < 2) return null;
  const rev = (current && usable.find((r) => r.versionId === current)) || usable[0];
  const older = usable.find((r) => r.number < rev.number);
  if (older) return { base: older.versionId, revision: rev.versionId };
  const newer = [...usable].reverse().find((r) => r.number > rev.number); // the next one up
  return newer ? { base: rev.versionId, revision: newer.versionId } : null;
}

export function formatRevisionDate(ms: number, locale?: string): string {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  try {
    return new Date(ms).toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}
