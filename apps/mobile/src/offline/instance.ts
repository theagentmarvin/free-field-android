import { db } from "@ff/data/db/database";
import { testHooksEnabled } from "../dev/flag";
import { getNetworkSnapshot } from "../platform/network";
import { getReachability } from "../platform/reachability";
import { getOfflineDb } from "./journal";
import { DownloadManager } from "./manager";
import { createNativeFiles } from "./nativeFiles";
import type { PlanRows } from "./plan";
import { readSettings } from "./settings";
import { DownloadedModelSource, DownloadedPlanSource, emitPlanDownloaded } from "./sources";
import { OfflineRefusal, type DownloadUrl } from "./types";

let urlProvider: ((storagePath: string) => Promise<DownloadUrl>) | null = null;
/** Set by the controller once Firebase Storage is available (never in demo mode). */
export function setUrlProvider(fn: typeof urlProvider): void {
  urlProvider = fn;
}

export async function loadRows(buildingId: string): Promise<PlanRows> {
  const ifcFiles = await db.ifcFiles.where("buildingId").equals(buildingId).toArray();
  const pdfFiles = await db.pdfFiles.where("buildingId").equals(buildingId).toArray();
  const ifcVersions = ifcFiles.length ? await db.ifcVersions.where("ifcFileId").anyOf(ifcFiles.map((f) => f.id)).toArray() : [];
  const pdfVersions = pdfFiles.length ? await db.pdfVersions.where("pdfFileId").anyOf(pdfFiles.map((f) => f.id)).toArray() : [];
  return { ifcFiles, ifcVersions, pdfFiles, pdfVersions };
}

/** e2e builds only: `localStorage["ffm.stallMs"]` shortens the stall watchdog. Folded away in release bundles. */
function stallOverride(): number | undefined {
  if (!testHooksEnabled()) return undefined;
  try {
    const v = Number(window.localStorage.getItem("ffm.stallMs"));
    return v > 0 ? v : undefined;
  } catch {
    return undefined;
  }
}

let manager: DownloadManager | null = null;
export const files = createNativeFiles();

export function getDownloadManager(): DownloadManager {
  return (manager ??= new DownloadManager({
    journal: getOfflineDb(),
    files,
    urlFor: async (p) => {
      if (!urlProvider) throw new OfflineRefusal("no-backend", "Offline packages need a backend connection (not available in demo mode).");
      return urlProvider(p);
    },
    loadRows,
    buildingName: async (id) => (await db.buildings.get(id))?.name ?? id,
    network: () => getNetworkSnapshot(),
    settings: () => readSettings(),
    onPlanDownloaded: emitPlanDownloaded,
    log: (m) => console.info("[offline]", m),
    stallMs: stallOverride(),
    onReachability: (ok) => getReachability().setEvidence("download", !ok),
  }));
}

/** Plans tab integration (docs/integration/plans-offline.md). */
export function getDownloadedPlanSource(): DownloadedPlanSource {
  return new DownloadedPlanSource({
    journal: getOfflineDb(),
    rows: {
      pdfFiles: (b) => db.pdfFiles.where("buildingId").equals(b).toArray(),
      pdfVersions: (ids) => (ids.length ? db.pdfVersions.where("pdfFileId").anyOf(ids).toArray() : Promise.resolve([])),
      storeys: (b) => db.storeys.where("buildingId").equals(b).toArray(),
      folders: async () => db.pdfFolders.toArray(),
      folderAssignments: (ids) => (ids.length ? db.pdfFolderAssignments.where("pdfFileId").anyOf(ids).toArray() : Promise.resolve([])),
    },
  });
}

/** Model tab integration (docs/integration/model-offline.md). */
export function getDownloadedModelSource(): DownloadedModelSource {
  return new DownloadedModelSource({
    journal: getOfflineDb(),
    ifcFiles: (b) => db.ifcFiles.where("buildingId").equals(b).toArray(),
    ifcVersion: (id) => db.ifcVersions.get(id),
  });
}

/** `getLocalFragPath(buildingId)`: file URI of the building's downloaded `.frag`, or null when not offline. */
export function getLocalFragPath(buildingId: string): Promise<string | null> {
  return getDownloadedModelSource().getLocalFragPath(buildingId);
}
