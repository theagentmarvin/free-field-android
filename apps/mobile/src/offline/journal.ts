import Dexie, { type Table } from "dexie";
import type { OfflineItem, OfflinePackage } from "./types";

/** Separate Dexie database for the download journal (the synced `free-field` DB stays owned by @ff/data). */
export class OfflineDb extends Dexie {
  items!: Table<OfflineItem, string>;
  packages!: Table<OfflinePackage, string>;

  constructor(name = "ffm-offline") {
    super(name);
    this.version(1).stores({
      items: "&id, buildingId, projectId, status",
      packages: "&buildingId, projectId",
    });
  }
}

let shared: OfflineDb | null = null;
export function getOfflineDb(): OfflineDb {
  return (shared ??= new OfflineDb());
}
