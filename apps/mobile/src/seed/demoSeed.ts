import { DEMO_PROJECT_ID, isDemoAuth } from "@ff/auth";
import { db } from "@ff/data/db/database";
import { listBuildings } from "@ff/data/db/tables/buildings";
import { runDemoTasksSeedIfEmpty } from "@ff/tasks-react";

/**
 * Demo-mode seed: injects the metadata tables of the bundled manifest (project,
 * building, storeys, plan records, calibrations) into Dexie WITHOUT any blob,
 * then lets the shared task engine seed its demo tasks. Blobs (the .frag) are
 * served separately through the BlobStore. No IFC is parsed (SPEC A5b).
 */
interface Manifest {
  format: string;
  tables?: Record<string, unknown[]>;
}

let inFlight: Promise<"seeded" | "skipped" | "unavailable"> | null = null;

export function seedDemoIfEmpty() {
  inFlight ??= run();
  return inFlight;
}

async function run(): Promise<"seeded" | "skipped" | "unavailable"> {
  if (!isDemoAuth()) return "skipped";
  try {
    if ((await listBuildings(DEMO_PROJECT_ID)).length === 0) {
      const res = await fetch("/seed/manifest.json");
      if (!res.ok) throw new Error(`manifest HTTP ${res.status}`);
      const m = (await res.json()) as Manifest;
      if (m.format !== "free-field-demo-seed") throw new Error("not a demo seed manifest");
      const t = m.tables ?? {};
      const order = [
        "projects",
        "buildings",
        "ifcFiles",
        "pdfFiles",
        "ifcVersions",
        "pdfVersions",
        "storeys",
        "extractedStoreys",
        "buildingLevelSelection",
        "pdfFolders",
        "pdfFolderAssignments",
        "calibrations",
      ] as const;
      await db.transaction(
        "rw",
        order.map((name) => db.table(name)),
        async () => {
          for (const name of order) {
            const rows = t[name];
            if (Array.isArray(rows) && rows.length) await db.table(name).bulkPut(rows);
          }
        },
      );
    }
    return (await runDemoTasksSeedIfEmpty()) === "seeded" ? "seeded" : "skipped";
  } catch (err) {
    console.warn("[demoSeed] failed", err);
    return "unavailable";
  }
}
