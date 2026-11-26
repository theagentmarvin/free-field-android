import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BuildingSchema,
  CalibrationSchema,
  ExtractedStoreySchema,
  FolderAssignmentSchema,
  FolderSchema,
  IfcFileSchema,
  IfcVersionSchema,
  PdfFileSchema,
  PdfVersionSchema,
  StoreySchema,
  SYNCED_COLLECTIONS,
} from "@ff/firestore";
import { buildRealDocs, calibrationDocId, type Manifest } from "../../../../e2e/emulator/realDataDocs";

const MANIFEST = join(__dirname, "../../../../vendor/free-field/apps/settings/public/seed/manifest.json");
const base = { updatedAt: { seconds: 1, nanoseconds: 0, toMillis: () => 1 }, updatedBy: "u", deletedAt: null, schema: 1 };
const SCHEMAS: Record<string, { safeParse(v: unknown): { success: boolean; error?: unknown } }> = {
  buildings: BuildingSchema,
  ifcFiles: IfcFileSchema,
  ifcVersions: IfcVersionSchema,
  storeys: StoreySchema,
  extractedStoreys: ExtractedStoreySchema,
  pdfFiles: PdfFileSchema,
  pdfVersions: PdfVersionSchema,
  calibrations: CalibrationSchema,
  folders: FolderSchema,
  folderAssignments: FolderAssignmentSchema,
};

// The full maintainer seed only exists in private development (the public web repository ships no seed): skip cleanly without it.
const HAS_SEED = existsSync(MANIFEST) && process.env.FFM_FORCE_APP_SEED !== "1";
describe.skipIf(!HAS_SEED)("realistic seed mapping (web demo manifest -> Phase 1c/1d docs)", () => {
  // describe bodies run at collection time even when skipped: never read the manifest without it.
  const m = (HAS_SEED ? JSON.parse(readFileSync(MANIFEST, "utf8")) : null) as Manifest;
  const built = HAS_SEED ? buildRealDocs(m, "p1", (_k, key) => ({ sha256: "a".repeat(64), size: key.length })) : ({ docs: [], blobs: [], fragVersions: [], pdfVersions: [] } as unknown as ReturnType<typeof buildRealDocs>);

  it("keeps the row counts of the manifest and every doc passes its zod schema", () => {
    const count = (c: string) => built.docs.filter((d) => d.collection === c).length;
    expect(count("buildings")).toBe(1);
    expect(count("ifcFiles")).toBe(3);
    expect(count("ifcVersions")).toBe(3);
    expect(count("storeys")).toBe(15);
    expect(count("extractedStoreys")).toBe(6);
    expect(count("pdfFiles")).toBe(3);
    expect(count("pdfVersions")).toBe(4);
    expect(count("calibrations")).toBe(1);
    expect(count("folders")).toBe(3);
    expect(count("folderAssignments")).toBe(3);
    for (const d of built.docs) {
      expect(SYNCED_COLLECTIONS).toContain(d.collection);
      const r = SCHEMAS[d.collection].safeParse({ ...d.data, ...base });
      expect(r.success, `${d.collection}/${d.id}: ${JSON.stringify((r as { error?: unknown }).error)}`).toBe(true);
    }
  });

  it("keeps manifest ids; contract-forced exceptions: calibration and assignment doc ids, project ids", () => {
    const ids = (c: string) => built.docs.filter((d) => d.collection === c).map((d) => d.id).sort();
    expect(ids("storeys")).toEqual(m.tables.storeys.map((s) => s.id).sort());
    expect(ids("ifcVersions")).toEqual(m.tables.ifcVersions.map((s) => s.id).sort());
    const cal = m.tables.calibrations[0];
    expect(ids("calibrations")).toEqual([calibrationDocId(cal.pdfFileId, cal.storeyName)]);
    expect(calibrationDocId("f", "101 FIRST FLOOR")).toBe("f__101%20FIRST%20FLOOR");
    expect(ids("folderAssignments")).toEqual(m.tables.pdfFolderAssignments.map((a) => a.pdfFileId).sort());
    for (const c of ["buildings", "calibrations", "folders"]) for (const d of built.docs.filter((x) => x.collection === c)) expect(d.data.projectId).toBe("p1");
  });

  it("blobs go to projects/{pid}/{frag,pdf}/{versionId}.* and are referenced by the version docs", () => {
    expect(built.blobs).toHaveLength(7);
    for (const b of built.blobs) {
      expect(b.storagePath).toBe(`projects/p1/${b.kind}/${b.versionId}.${b.kind}`);
      const doc = built.docs.find((d) => d.id === b.versionId)!;
      expect(doc.data[b.kind === "frag" ? "fragStoragePath" : "storagePath"]).toBe(b.storagePath);
    }
  });
});
