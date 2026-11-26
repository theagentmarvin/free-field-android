import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildRealDocs, type Manifest, type RealDocs } from "./realDataDocs";
import { setDoc, Timestamp, uploadObject } from "./rest";

/** The web app's demo dataset, read in place from the vendored monorepo (never copied into this repo). */
export const SEED_DIR = join(process.cwd(), "vendor/free-field/apps/settings/public/seed");
export const REAL_PROJECT_ID = "real-demo";
export const REAL_PROJECT_NAME = "Demo (web dataset)";

export const loadManifest = (): Manifest => JSON.parse(readFileSync(join(SEED_DIR, "manifest.json"), "utf8")) as Manifest;
const blobPath = (kind: "frag" | "pdf", key: string) => join(SEED_DIR, "blobs", kind === "frag" ? "fragBlobs" : "pdfBlobs", key);

export interface RealSeedResult extends RealDocs {
  projectId: string;
  buildingId: string;
  buildingName: string;
  totalBytes: number;
  sha: Map<string, string>;
  sizes: Map<string, number>;
  manifest: Manifest;
}

/**
 * Publishes the full manifest dataset through the Phase 1c/1d contract: flat `projects/{pid}/<table>` docs with
 * `updatedAt`, blobs at `projects/{pid}/frag/{versionId}.frag` and `projects/{pid}/pdf/{versionId}.pdf` with sha256.
 * Blobs are uploaded first, then the docs (the same order the web uploader uses). `uids` become active members.
 */
export async function seedRealData(uids: string[], projectId = REAL_PROJECT_ID): Promise<RealSeedResult> {
  const manifest = loadManifest();
  const sha = new Map<string, string>();
  const sizes = new Map<string, number>();
  const info = (kind: "frag" | "pdf", key: string) => {
    const k = `${kind}:${key}`;
    if (!sha.has(k)) {
      sha.set(k, createHash("sha256").update(readFileSync(blobPath(kind, key))).digest("hex"));
      sizes.set(k, statSync(blobPath(kind, key)).size);
    }
    return { sha256: sha.get(k)!, size: sizes.get(k)! };
  };
  const built = buildRealDocs(manifest, projectId, info);

  const now = new Timestamp(new Date().toISOString());
  await setDoc(`projects/${projectId}`, { name: REAL_PROJECT_NAME, ownerUid: "e2e-admin", createdAt: Date.now() });
  await setDoc(`projects/${projectId}/taskCounters/tasks`, { next: 0 });
  for (const uid of uids) await setDoc(`projects/${projectId}/members/${uid}`, { uid, role: "member", status: "active", joinedAt: now, invitedBy: "e2e-seed" });

  for (const b of built.blobs) await uploadObject(b.storagePath, new Uint8Array(readFileSync(blobPath(b.kind, b.sourceKey))), b.contentType);
  for (const d of built.docs) {
    // the REST path is URL-decoded by the emulator: a calibration id holds a literal `%20`, so encode it once more
    await setDoc(`projects/${projectId}/${d.collection}/${encodeURIComponent(d.id)}`, { ...d.data, updatedAt: new Timestamp(new Date().toISOString()), updatedBy: "e2e-admin", deletedAt: null, schema: 1 });
  }
  const building = manifest.tables.buildings[0];
  const totalBytes = built.blobs.reduce((n, b) => n + (sizes.get(`${b.kind}:${b.sourceKey}`) ?? 0), 0);
  return { ...built, projectId, buildingId: building.id, buildingName: building.name, totalBytes, sha, sizes, manifest };
}
