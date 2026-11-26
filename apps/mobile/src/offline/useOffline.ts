import { useSyncExternalStore } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { getDownloadManager } from "./instance";
import { summarize } from "./plan";
import type { OfflineItem, OfflinePackage, PackageSummary } from "./types";

export interface PackageView {
  pkg: OfflinePackage | undefined;
  items: OfflineItem[];
  summary: PackageSummary;
}

/**
 * Live journal state per building (Dexie liveQuery): drives badges and progress. Rows the journal could not
 * store (disk full) come from the manager's in-memory copy, so a stalled or failed download is still shown.
 */
export function useOfflineState(projectId: string | null | undefined): Map<string, PackageView> | undefined {
  const manager = getDownloadManager();
  const memVersion = useSyncExternalStore(manager.subscribeMemory, manager.memoryVersion, manager.memoryVersion);
  return useLiveQuery(async () => {
    const { pkgs, items } = projectId ? await manager.snapshot(projectId) : { pkgs: [], items: [] };
    const out = new Map<string, PackageView>();
    for (const pkg of pkgs) {
      const mine = items.filter((i) => i.buildingId === pkg.buildingId);
      out.set(pkg.buildingId, { pkg, items: mine, summary: summarize(pkg, mine) });
    }
    return out;
  }, [projectId, memVersion, manager]);
}
