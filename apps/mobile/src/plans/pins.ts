import { extractPdfPins, type LocatablePdfTask, type PdfPin } from "@ff/tasks-react";
import type { PanelTask } from "@ff/tasks-react";
import type { PdfVersionRecord } from "@ff/types";
import { pinRevision, type PinRevision } from "./revisions";
import { uvInPage } from "./viewMath";

/**
 * A pin on a plan. `uv` is normalized over the page. `pdfVersionId` is the revision the pin was
 * placed on (absent on legacy pins); `onEarlierRevision` is true when that is not the version being shown.
 */
export interface PlanPin {
  taskId: string;
  num: number;
  title: string;
  status: number;
  pending: boolean;
  uv: [number, number];
  pdfVersionId?: string;
  onEarlierRevision: boolean;
  /** Which revision the pin was placed on, relative to the displayed one (names the revision number when it is known). */
  revision: PinRevision;
}

/**
 * Pins for one plan file from the panel's merged task list (cloud/demo rows plus
 * queued outbox creates). The stored location is `{pdfFileId, page, uv, calibId, pdfVersionId?}`.
 * A pin whose `pdfVersionId` equals the displayed version is "current"; one from another version,
 * or without any version (legacy), is flagged `onEarlierRevision` so the viewer styles it distinctly.
 */
export function pinsForPlan(tasks: readonly PanelTask[], pdfFileId: string, displayedVersionId: string, page = 1, versions: readonly PdfVersionRecord[] = []): PlanPin[] {
  const pending = new Set(tasks.filter((t) => t.pending).map((t) => t.id));
  const pins = extractPdfPins(tasks as unknown as LocatablePdfTask[]);
  return pins
    .filter((p: PdfPin) => p.pdfFileId === pdfFileId && p.page === page && uvInPage(p.uv))
    .map((p: PdfPin) => ({
      taskId: p.taskId,
      num: p.num,
      title: p.title,
      status: p.status,
      pending: pending.has(p.taskId),
      uv: p.uv,
      pdfVersionId: p.pdfVersionId,
      onEarlierRevision: p.pdfVersionId !== displayedVersionId,
      revision: pinRevision(p.pdfVersionId, displayedVersionId, versions),
    }));
}
