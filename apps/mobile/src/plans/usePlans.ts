import { useLiveQuery } from "dexie-react-hooks";
import { isDemoAuth } from "@ff/auth";
import { db } from "@ff/data/db/database";
import { listBuildings } from "@ff/data/db/tables/buildings";
import type { PdfVersionRecord } from "@ff/types";
import { getDownloadedPlanSource } from "../offline/instance";
import { groupPlans, latestVersion, toVersionRef, type PlanBuildingGroup } from "./planModel";
import type { PlanVersionRef } from "./planSource";

/**
 * Plans of the current project, grouped. Cloud mode lists what the offline layer reports
 * (`DownloadedPlanSource`: the newest version on the device per plan, plans not downloaded are listed as
 * not offline); demo mode keeps the demo source (every synced plan, latest version).
 */
export function usePlanGroups(projectId: string): PlanBuildingGroup[] | undefined {
  return useLiveQuery(async () => {
    const [buildings, files, versions, folders, assignments, calibrations] = await Promise.all([
      listBuildings(projectId),
      db.pdfFiles.toArray(),
      db.pdfVersions.toArray(),
      db.pdfFolders.toArray(),
      db.pdfFolderAssignments.toArray(),
      db.calibrations.toArray(),
    ]);
    let downloaded: Map<string, PdfVersionRecord | null> | undefined;
    if (!isDemoAuth()) {
      const src = getDownloadedPlanSource();
      downloaded = new Map();
      for (const b of buildings) for (const p of await src.listPlans(b.id)) downloaded.set(p.file.id, p.downloaded?.version ?? null);
    }
    return groupPlans({ buildings, files, versions, folders, assignments, calibrations, downloaded });
  }, [projectId]);
}

export interface PlanRecord {
  file: { id: string; name: string; buildingId: string } | undefined;
  /** Version to display: the requested revision, else the newest on the device (cloud) or the latest synced one (demo). */
  version: PdfVersionRecord | undefined;
  ref: PlanVersionRef | null;
  /** A synced version exists but nothing of this plan is on the device (cloud only). */
  notOffline: boolean;
  /** Every synced revision, newest first. */
  versions: PdfVersionRecord[];
  /** The newest synced revision. */
  latest: PdfVersionRecord | undefined;
  /** Ids of the revisions whose PDF is on the device; null = all of them (demo mode). */
  onDevice: ReadonlySet<string> | null;
  /** The revision asked for (`revisionId`) exists but its PDF is not on the device. */
  revisionMissing: PdfVersionRecord | undefined;
}

const EMPTY: PlanRecord = { file: undefined, version: undefined, ref: null, notOffline: false, versions: [], latest: undefined, onDevice: null, revisionMissing: undefined };

/**
 * One plan for the viewer route. In cloud mode it never shows a version whose PDF is not on the device.
 * `revisionId` opens that revision instead of the newest one (read-only history view).
 */
export function usePlanRecord(pdfFileId: string, revisionId?: string | null): PlanRecord | undefined {
  return useLiveQuery(async (): Promise<PlanRecord> => {
    const file = await db.pdfFiles.get(pdfFileId);
    if (!file) return EMPTY;
    const versions = (await db.pdfVersions.where("pdfFileId").equals(pdfFileId).toArray()).sort((a, b) => b.versionNumber - a.versionNumber);
    const latest = latestVersion(versions);
    const asked = revisionId ? versions.find((v) => v.id === revisionId) : undefined;
    if (isDemoAuth()) {
      const version = asked ?? latest;
      return { file, version, ref: version ? toVersionRef(file, version) : null, notOffline: false, versions, latest, onDevice: null, revisionMissing: undefined };
    }
    const entry = (await getDownloadedPlanSource().listPlans(file.buildingId)).find((p) => p.file.id === pdfFileId);
    const onDevice = new Set((entry?.versions ?? []).filter((v) => v.localKey).map((v) => v.version.id));
    const newest = entry?.downloaded?.version;
    const askedHere = asked && onDevice.has(asked.id) ? asked : undefined;
    const version = askedHere ?? (asked ? undefined : newest);
    return {
      file,
      version,
      ref: version ? toVersionRef(file, version) : null,
      notOffline: !newest,
      versions,
      latest,
      onDevice,
      revisionMissing: asked && !askedHere ? asked : undefined,
    };
  }, [pdfFileId, revisionId]);
}
