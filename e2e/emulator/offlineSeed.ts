import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setDoc, Timestamp, uploadObject } from "./rest";

const VENDOR = join(process.cwd(), "vendor/free-field/apps/settings/public");
export const SAMPLE_FRAG = join(VENDOR, "seed/blobs/fragBlobs/662b163f-d974-46fe-b30a-227893228444__v1");
export const SAMPLE_PDF = join(VENDOR, "samples/S-101 - First Floor.pdf");

export const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
export const randomBlob = (bytes: number) => new Uint8Array(randomBytes(bytes));

const base = () => ({ updatedAt: new Timestamp(new Date().toISOString()), updatedBy: "e2e-admin", deletedAt: null, schema: 1 });

export interface SeedBuilding {
  projectId: string;
  buildingId: string;
  name: string;
  fragVersionId?: string;
  fragFileId?: string;
  pdfVersionId?: string;
  pdfFileId?: string;
  frag?: Uint8Array;
  pdf?: Uint8Array;
  /** Bytes actually stored for the PDF when they must differ from the documented ones. */
  pdfStored?: Uint8Array;
  versionNumber?: number;
  /** An older revision of the plan (version number `versionNumber - 1`, not latest); needs `pdf` and `versionNumber >= 2`. */
  olderPdf?: Uint8Array;
  olderPdfVersionId?: string;
}

/** Writes the building, its model file/version and plan file/version docs, and uploads the blobs. */
export async function seedBuilding(b: SeedBuilding): Promise<void> {
  const p = `projects/${b.projectId}`;
  await setDoc(`${p}/buildings/${b.buildingId}`, { ...base(), id: b.buildingId, projectId: b.projectId, name: b.name, metadata: {}, createdAt: 1 });
  const vn = b.versionNumber ?? 1;
  if (b.frag) {
    const fid = b.fragFileId ?? `${b.buildingId}-ifc`;
    const vid = b.fragVersionId ?? `${b.buildingId}-iv${vn}`;
    await uploadObject(`${p}/frag/${vid}.frag`, b.frag);
    await setDoc(`${p}/ifcFiles/${fid}`, { ...base(), id: fid, buildingId: b.buildingId, name: `${b.name} structure`, currentVersionId: vid, createdAt: 1 });
    await setDoc(`${p}/ifcVersions/${vid}`, {
      ...base(),
      id: vid,
      ifcFileId: fid,
      versionNumber: vn,
      ifcFileSize: 1,
      contentHash: "x",
      fragBlobKey: `${fid}__v${vn}`,
      storeyCount: 1,
      createdAt: 1,
      isLatest: true,
      storagePath: null,
      sha256: null,
      sizeBytes: null,
      contentType: null,
      fragStoragePath: `${p}/frag/${vid}.frag`,
      fragSha256: sha256(b.frag),
      fragSizeBytes: b.frag.length,
    });
  }
  if (b.pdf) {
    const fid = b.pdfFileId ?? `${b.buildingId}-pdf`;
    const vid = b.pdfVersionId ?? `${b.buildingId}-pv${vn}`;
    await uploadObject(`${p}/pdf/${vid}.pdf`, b.pdfStored ?? b.pdf, "application/pdf");
    await setDoc(`${p}/pdfFiles/${fid}`, { ...base(), id: fid, buildingId: b.buildingId, name: `${b.name} plan`, createdAt: 1 });
    await setDoc(`${p}/pdfVersions/${vid}`, {
      ...base(),
      id: vid,
      pdfFileId: fid,
      versionNumber: vn,
      name: "plan.pdf",
      size: b.pdf.length,
      contentHash: "x",
      pageCount: 1,
      width: 612,
      height: 792,
      storedAt: 1,
      blobKey: `${fid}__v${vn}`,
      isLatest: true,
      storagePath: `${p}/pdf/${vid}.pdf`,
      sha256: sha256(b.pdf),
      sizeBytes: b.pdf.length,
      contentType: "application/pdf",
    });
    if (b.olderPdf) await seedOlderPdf(b, vn);
  }
}

/** Writes the older revision of a plan (see `SeedBuilding.olderPdf`): its blob and `pdfVersions` doc. */
async function seedOlderPdf(b: SeedBuilding, vn: number): Promise<void> {
  const p = `projects/${b.projectId}`;
  const fid = b.pdfFileId ?? `${b.buildingId}-pdf`;
  const vid = b.olderPdfVersionId ?? `${b.buildingId}-pv${vn - 1}`;
  const pdf = b.olderPdf!;
  await uploadObject(`${p}/pdf/${vid}.pdf`, pdf, "application/pdf");
  await setDoc(`${p}/pdfVersions/${vid}`, {
    ...base(),
    id: vid,
    pdfFileId: fid,
    versionNumber: vn - 1,
    name: "plan-older.pdf",
    size: pdf.length,
    contentHash: "x",
    pageCount: 1,
    width: 612,
    height: 792,
    storedAt: 1,
    blobKey: `${fid}__v${vn - 1}`,
    isLatest: false,
    storagePath: `${p}/pdf/${vid}.pdf`,
    sha256: sha256(pdf),
    sizeBytes: pdf.length,
    contentType: "application/pdf",
  });
}

export const readSample = (path: string): Uint8Array => new Uint8Array(readFileSync(path));
