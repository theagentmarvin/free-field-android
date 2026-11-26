import type { BuildingRecord, CalibrationRecord, PdfFileRecord, PdfFolderAssignmentRecord, PdfFolderRecord, PdfVersionRecord } from "@ff/types";
import type { PlanVersionRef } from "./planSource";

export interface PlanGroup {
  name: string;
  plans: PlanListItem[];
}
export interface PlanBuildingGroup {
  buildingId: string;
  buildingName: string;
  groups: PlanGroup[];
}
export interface PlanListItem {
  pdfFileId: string;
  name: string;
  /** The version shown: the newest one on the device (cloud) or the latest synced one (demo). */
  version: PdfVersionRecord;
  ref: PlanVersionRef;
  /** Number of synced revisions of the plan (1 = no history to show). */
  revisionCount: number;
  /** False when the plan is listed (metadata synced) but its PDF is not on the device. */
  offline: boolean;
}

export const UNFILED = "Unfiled";

export function latestVersion(versions: readonly PdfVersionRecord[]): PdfVersionRecord | undefined {
  const flagged = versions.find((v) => v.isLatest);
  if (flagged) return flagged;
  return [...versions].sort((a, b) => b.versionNumber - a.versionNumber)[0];
}

export function toVersionRef(file: Pick<PdfFileRecord, "id" | "name">, v: PdfVersionRecord): PlanVersionRef {
  return { planVersionId: v.id, pdfFileId: file.id, blobKey: v.blobKey, name: file.name, ...(v.sha256 ? { sha256: v.sha256 } : {}) };
}

/**
 * Building -> folder (or calibrated storey) -> plan, sorted by name; plans without a version are skipped.
 * `downloaded` (cloud mode, from `DownloadedPlanSource`) maps a file id to the version on the device (null =
 * not downloaded): that version is the one shown, and a plan without one is listed as not offline.
 * Without it (demo mode) every plan counts as offline and shows its latest version.
 */
export function groupPlans(input: {
  buildings: readonly Pick<BuildingRecord, "id" | "name">[];
  files: readonly PdfFileRecord[];
  versions: readonly PdfVersionRecord[];
  folders: readonly PdfFolderRecord[];
  assignments: readonly PdfFolderAssignmentRecord[];
  calibrations: readonly CalibrationRecord[];
  downloaded?: ReadonlyMap<string, PdfVersionRecord | null>;
}): PlanBuildingGroup[] {
  const folderName = new Map(input.folders.map((f) => [f.id, f.name]));
  const folderOf = new Map(input.assignments.map((a) => [a.pdfFileId, folderName.get(a.folderId)]));
  const storeyOf = new Map<string, string>();
  for (const c of [...input.calibrations].sort((a, b) => a.updatedAt - b.updatedAt)) storeyOf.set(c.pdfFileId, c.storeyName);
  const byFile = new Map<string, PdfVersionRecord[]>();
  for (const v of input.versions) byFile.set(v.pdfFileId, [...(byFile.get(v.pdfFileId) ?? []), v]);

  const out: PlanBuildingGroup[] = [];
  for (const b of input.buildings) {
    const groups = new Map<string, PlanListItem[]>();
    for (const f of input.files.filter((f) => f.buildingId === b.id)) {
      const latest = latestVersion(byFile.get(f.id) ?? []);
      const local = input.downloaded ? (input.downloaded.get(f.id) ?? null) : latest;
      const v = local ?? latest;
      if (!v) continue;
      const g = folderOf.get(f.id) ?? storeyOf.get(f.id) ?? UNFILED;
      groups.set(g, [...(groups.get(g) ?? []), { pdfFileId: f.id, name: f.name, version: v, ref: toVersionRef(f, v), revisionCount: (byFile.get(f.id) ?? []).length, offline: local !== null && local !== undefined }]);
    }
    if (groups.size === 0) continue;
    out.push({
      buildingId: b.id,
      buildingName: b.name,
      groups: [...groups.entries()]
        .sort(([a], [b2]) => (a === UNFILED ? 1 : b2 === UNFILED ? -1 : a.localeCompare(b2)))
        .map(([name, plans]) => ({ name, plans: plans.sort((x, y) => x.name.localeCompare(y.name)) })),
    });
  }
  return out.sort((a, b) => a.buildingName.localeCompare(b.buildingName));
}
