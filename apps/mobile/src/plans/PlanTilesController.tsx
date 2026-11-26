import { useEffect } from "react";
import { liveQuery } from "dexie";
import { isDemoAuth, useProjectId } from "@ff/auth";
import { db } from "@ff/data/db/database";
import { getDownloadedPlanSource } from "../offline/instance";
import { getOfflineDb } from "../offline/journal";
import { onPlanDownloaded } from "../offline/sources";
import { getBlobStore } from "../storage";
import { getTileService } from "./tileService";
import { latestVersion } from "./planModel";
import { PlanTileSync } from "./tileSync";

export function createPlanTileSync(): PlanTileSync {
  return new PlanTileSync({
    tiles: getTileService(),
    store: getBlobStore(),
    listPlans: (b) => getDownloadedPlanSource().listPlans(b),
    planName: async (id) => (await db.pdfFiles.get(id))?.name,
    versionIds: async (id) => (await db.pdfVersions.where("pdfFileId").equals(id).toArray()).map((v) => v.id),
    isNewest: async (id, versionId) => {
      const all = await db.pdfVersions.where("pdfFileId").equals(id).toArray();
      return latestVersion(all)?.id === versionId || !all.some((v) => v.id === versionId);
    },
    log: (m) => console.info("[plans]", m),
  });
}

/**
 * Cloud mode only. Pre-renders the tile pyramid of every plan the offline layer downloads
 * (`onPlanDownloaded`), reconciles at start and whenever the set of downloaded PDFs changes (renders what is
 * missing, drops tiles of superseded versions and removed packages). Mounted before OfflineController so the
 * hook is registered before a resumed download can finish.
 */
export function PlanTilesController() {
  const projectId = useProjectId();
  useEffect(() => {
    if (isDemoAuth() || !projectId) return;
    const sync = createPlanTileSync();
    const off = onPlanDownloaded((e) => sync.onDownloaded(e));

    let running = false;
    let again = false;
    const reconcile = async () => {
      if (running) {
        again = true;
        return;
      }
      running = true;
      try {
        do {
          again = false;
          const buildings = await db.buildings.where("projectId").equals(projectId).toArray();
          await sync.reconcile(buildings.map((b) => b.id));
        } while (again);
      } catch (e) {
        console.warn("[plans] tile reconcile failed", e);
      } finally {
        running = false;
      }
    };
    // Re-run when the set of finished PDF downloads changes (start-up, update landed, package removed).
    let last = "";
    const sub = liveQuery(async () =>
      (await getOfflineDb().items.where("projectId").equals(projectId).filter((i) => i.kind === "pdf" && i.status === "done").toArray())
        .map((i) => i.id)
        .sort()
        .join(","),
    ).subscribe({
      next: (sig) => {
        if (sig === last) return;
        last = sig;
        void reconcile();
      },
      error: (e) => console.warn("[plans] journal watch failed", e),
    });
    return () => {
      off();
      sub.unsubscribe();
    };
  }, [projectId]);
  return null;
}
