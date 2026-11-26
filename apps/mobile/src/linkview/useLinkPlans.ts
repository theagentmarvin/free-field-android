import { useLiveQuery } from "dexie-react-hooks";
import { db } from "@ff/data/db/database";
import type { StoreyRecord } from "@ff/types";
import { calibratedPlans, sortPlans, type CalibratedPlan } from "./plans";
import { storeyChips } from "../model/storeys";
import { walkLevels, type WalkLevel } from "../model/walkLevels";

export interface LinkData {
  storeys: StoreyRecord[];
  levels: WalkLevel[];
  plans: CalibratedPlan[];
}

/** Storeys and calibrated plans of one building, live from the device database (offline-safe: no network). */
export function useLinkData(projectId: string, buildingId: string, enabled = true): LinkData | undefined {
  return useLiveQuery(async () => {
    if (!enabled) return { storeys: [], levels: [], plans: [] };
    const [storeys, files, calibrations] = await Promise.all([db.storeys.where("buildingId").equals(buildingId).toArray(), db.pdfFiles.where("buildingId").equals(buildingId).toArray(), db.calibrations.toArray()]);
    const levels = walkLevels(storeyChips(storeys));
    return { storeys, levels, plans: sortPlans(calibratedPlans({ files, calibrations, storeys, projectId, buildingId }), levels) };
  }, [projectId, buildingId, enabled]);
}

/** Calibrated plans of one plan file (its building's data), for the plan viewer's entry. */
export function usePlanLinkability(projectId: string, pdfFileId: string): { buildingId: string; plans: CalibratedPlan[] } | null | undefined {
  return useLiveQuery(async () => {
    const file = await db.pdfFiles.get(pdfFileId);
    if (!file) return null;
    const [storeys, files, calibrations] = await Promise.all([db.storeys.where("buildingId").equals(file.buildingId).toArray(), db.pdfFiles.where("buildingId").equals(file.buildingId).toArray(), db.calibrations.where("pdfFileId").equals(pdfFileId).toArray()]);
    return { buildingId: file.buildingId, plans: calibratedPlans({ files, calibrations, storeys, projectId, buildingId: file.buildingId }).filter((p) => p.pdfFileId === pdfFileId) };
  }, [projectId, pdfFileId]);
}
