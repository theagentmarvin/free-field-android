/**
 * Pure mapping of the web app's demo seed manifest (apps/settings/public/seed/manifest.json) onto the Phase 1c/1d
 * backend contract: flat `projects/{pid}/<collection>/{docId}` docs and the Storage paths of the blobs.
 * No I/O here so a unit test can validate every doc against the `@ff/firestore` zod schemas.
 */

export interface Manifest {
  tables: Record<string, Array<Record<string, any>>>;
  fragBlobs: Array<{ key: string }>;
  pdfBlobs: Array<{ key: string }>;
}

export interface BlobSpec {
  /** Storage object path inside the bucket. */
  storagePath: string;
  /** Key of the source file under seed/blobs/<fragBlobs|pdfBlobs>/. */
  sourceKey: string;
  kind: "frag" | "pdf";
  versionId: string;
  contentType: string;
}

export interface DocSpec {
  path: string;
  data: Record<string, unknown>;
  /** The sync base is added by the caller (it needs a Timestamp type). */
}

export const calibrationDocId = (pdfFileId: string, storeyName: string) => `${pdfFileId}__${encodeURIComponent(storeyName)}`;

export interface RealDocs {
  docs: Array<{ collection: string; id: string; data: Record<string, unknown> }>;
  blobs: BlobSpec[];
  /** version id -> sha/size are filled in by the seeder once the bytes are hashed. */
  fragVersions: Array<{ versionId: string; fileId: string; fileName: string; blobKey: string }>;
  pdfVersions: Array<{ versionId: string; fileId: string; fileName: string; blobKey: string }>;
}

export interface BlobInfo {
  sha256: string;
  size: number;
}

/**
 * `info` maps a source key (fragBlobs/pdfBlobs key) to its hash and size. Rows keep their manifest ids; the three
 * exceptions are forced by the contract: the project id (`projectId`), calibrations (doc id =
 * `{pdfFileId}__{storeyName}`) and folder assignments (doc id = pdfFileId). `propertyCatalog` and
 * `buildingLevelSelection` are web-only UI tables with no synced collection.
 */
export function buildRealDocs(m: Manifest, projectId: string, info: (kind: "frag" | "pdf", sourceKey: string) => BlobInfo): RealDocs {
  const t = m.tables;
  const docs: RealDocs["docs"] = [];
  const blobs: BlobSpec[] = [];
  const fragVersions: RealDocs["fragVersions"] = [];
  const pdfVersions: RealDocs["pdfVersions"] = [];
  const add = (collection: string, id: string, data: Record<string, unknown>) => docs.push({ collection, id, data: { id, ...data } });

  for (const b of t.buildings ?? []) add("buildings", b.id, { projectId, name: b.name, metadata: b.metadata ?? {}, createdAt: b.createdAt });
  for (const f of t.ifcFiles ?? []) add("ifcFiles", f.id, { buildingId: f.buildingId, name: f.name, currentVersionId: f.currentVersionId, createdAt: f.createdAt });
  for (const v of t.ifcVersions ?? []) {
    const file = (t.ifcFiles ?? []).find((f) => f.id === v.ifcFileId)!;
    const bi = info("frag", v.fragBlobKey);
    const storagePath = `projects/${projectId}/frag/${v.id}.frag`;
    blobs.push({ storagePath, sourceKey: v.fragBlobKey, kind: "frag", versionId: v.id, contentType: "application/octet-stream" });
    fragVersions.push({ versionId: v.id, fileId: file.id, fileName: file.name, blobKey: v.fragBlobKey });
    add("ifcVersions", v.id, {
      ifcFileId: v.ifcFileId,
      versionNumber: v.versionNumber,
      ifcFileSize: v.ifcFileSize,
      contentHash: v.contentHash,
      fragBlobKey: v.fragBlobKey,
      storeyCount: v.storeyCount,
      createdAt: v.createdAt,
      isLatest: v.isLatest,
      storagePath: null,
      sha256: null,
      sizeBytes: null,
      contentType: null,
      fragStoragePath: storagePath,
      fragSha256: bi.sha256,
      fragSizeBytes: bi.size,
    });
  }
  for (const s of t.storeys ?? [])
    add("storeys", s.id, {
      buildingId: s.buildingId,
      ifcVersionId: s.ifcVersionId,
      sourceIfcFileId: s.sourceIfcFileId,
      name: s.name,
      elevation: s.elevation,
      expressId: s.expressId,
      height: s.height ?? null,
      containedElementIds: s.containedElementIds ?? [],
    });
  for (const e of t.extractedStoreys ?? []) add("extractedStoreys", e.id, { buildingId: e.buildingId, storeyId: e.storeyId });
  for (const f of t.pdfFiles ?? []) add("pdfFiles", f.id, { buildingId: f.buildingId, name: f.name, createdAt: f.createdAt });
  for (const v of t.pdfVersions ?? []) {
    const file = (t.pdfFiles ?? []).find((f) => f.id === v.pdfFileId)!;
    const bi = info("pdf", v.blobKey);
    const storagePath = `projects/${projectId}/pdf/${v.id}.pdf`;
    blobs.push({ storagePath, sourceKey: v.blobKey, kind: "pdf", versionId: v.id, contentType: "application/pdf" });
    pdfVersions.push({ versionId: v.id, fileId: file.id, fileName: file.name, blobKey: v.blobKey });
    add("pdfVersions", v.id, {
      pdfFileId: v.pdfFileId,
      versionNumber: v.versionNumber,
      name: v.name,
      size: v.size,
      contentHash: v.contentHash,
      pageCount: v.pageCount,
      width: v.width,
      height: v.height,
      storedAt: v.storedAt,
      blobKey: v.blobKey,
      isLatest: v.isLatest,
      storagePath,
      sha256: bi.sha256,
      sizeBytes: bi.size,
      contentType: "application/pdf",
    });
  }
  for (const c of t.calibrations ?? [])
    add("calibrations", calibrationDocId(c.pdfFileId, c.storeyName), {
      projectId,
      pdfFileId: c.pdfFileId,
      storeyName: c.storeyName,
      pointPairs: c.pointPairs,
      transformParams: c.transformParams,
      confidence: c.confidence,
      createdAt: c.createdAt,
    });
  for (const f of t.pdfFolders ?? []) add("folders", f.id, { projectId, parentId: f.parentId ?? null, name: f.name, color: f.color ?? "", createdAt: f.createdAt });
  for (const a of t.pdfFolderAssignments ?? []) add("folderAssignments", a.pdfFileId, { pdfFileId: a.pdfFileId, folderId: a.folderId, createdAt: a.createdAt });
  return { docs, blobs, fragVersions, pdfVersions };
}
