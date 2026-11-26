import { Capacitor } from "@capacitor/core";
import { isDemoAuth } from "@ff/auth";
import type { IfcFileListItem } from "@ff/viewer-react";
import { getBlobStore, sha256Hex } from "../storage";
import { localUriForKey } from "../offline/sources";
import { campusSpec, expandCampus } from "./heavyCampus";

/** One bundled demo model: an already-built .frag (never parsed from IFC), listed by prepare-assets in models.json. */
export interface SampleModel {
  fileId: string;
  name: string;
  versionId: string;
  versionNumber: number;
  fragBlobKey: string;
  /** Path of the bundled file inside the app. */
  asset: string;
  size: number;
}

/** Models at or below this size are copied into the BlobStore (the disk path real packages use); bigger ones are
 * read straight from the app bundle, because a whole-file copy through the bridge would cost hundreds of MB of RAM. */
export const INSTALL_MAX_BYTES = 8 * 1024 * 1024;

export const fragStoreKey = (fragBlobKey: string) => `frag/${fragBlobKey}.frag`;

let samples: Promise<SampleModel[]> | null = null;
/** The demo building's models (all of them, like the web demo), smallest first. */
export function sampleModels(): Promise<SampleModel[]> {
  return (samples ??= fetch("/samples/models.json").then(async (res) => {
    if (!res.ok) throw new Error(`sample list HTTP ${res.status}`);
    return (await res.json()) as SampleModel[];
  })).then((all) => {
    const spec = campusSpec(); // test builds only: the synthetic heavy federation
    return spec ? expandCampus(all, spec) : all;
  }).catch((e) => {
    samples = null;
    throw e;
  });
}

/**
 * Demo mode: install the small bundled models into the BlobStore (standing in for the download manager) so the
 * viewer exercises the same disk path real packages use. Resolves with the install time in ms.
 */
export async function installSample(): Promise<number> {
  const store = getBlobStore();
  const t0 = performance.now();
  for (const m of await sampleModels()) {
    if (m.size > INSTALL_MAX_BYTES || (await store.stat(fragStoreKey(m.fragBlobKey)))) continue;
    const res = await fetch(m.asset);
    if (!res.ok) throw new Error(`sample ${m.name} fetch HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    await store.write(fragStoreKey(m.fragBlobKey), bytes, { sha256: await sha256Hex(bytes) });
  }
  return Math.round(performance.now() - t0);
}

export function sampleFiles(buildingId: string, models: SampleModel[]): IfcFileListItem[] {
  return models.map((m) => ({
    file: { id: m.fileId, name: m.name, buildingId },
    latestVersion: { id: m.versionId, fragBlobKey: m.fragBlobKey, versionNumber: m.versionNumber },
  }));
}

/**
 * Bytes of a downloaded `.frag` for the viewer. On device the WebView file server streams the file straight
 * into a Blob (no base64 copy through the bridge); the BlobStore read is the fallback and the test path.
 */
export async function readFragBlob(fragBlobKey: string): Promise<Blob | null> {
  const key = fragStoreKey(fragBlobKey);
  if (Capacitor.isNativePlatform()) {
    try {
      const uri = await localUriForKey(key);
      if (uri) {
        const res = await fetch(Capacitor.convertFileSrc(uri));
        if (res.ok) return await res.blob();
      }
    } catch (e) {
      console.warn("[model] file-server read failed, falling back to BlobStore", e);
    }
  }
  const bytes = await getBlobStore().read(key);
  if (bytes) return new Blob([bytes as BlobPart]);
  // Demo: a big bundled model is served from the app itself (the WebView streams it into a Blob).
  if (isDemoAuth()) {
    const m = (await sampleModels().catch(() => [])).find((s) => s.fragBlobKey === fragBlobKey);
    if (m) {
      const res = await fetch(m.asset);
      if (res.ok) return await res.blob();
    }
  }
  return null;
}
