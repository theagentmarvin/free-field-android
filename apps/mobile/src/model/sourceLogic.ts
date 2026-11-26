import type { IfcFileListItem } from "@ff/viewer-react";
import type { DownloadedModel } from "../offline/sources";

export function toFileItems(models: readonly DownloadedModel[]): IfcFileListItem[] {
  return models.map((m) => ({
    file: { id: m.file.id, name: m.file.name, buildingId: m.file.buildingId },
    latestVersion: { id: m.version.id, fragBlobKey: m.version.fragBlobKey, versionNumber: m.version.versionNumber },
  }));
}

/** What the Model tab shows for a building: the downloaded .frag files, else (demo mode) the bundled sample, else nothing. */
export function resolveSource(models: readonly DownloadedModel[] | undefined, demo: boolean): "loading" | "downloaded" | "sample" | "none" {
  if (models === undefined) return "loading";
  if (models.length > 0) return "downloaded";
  return demo ? "sample" : "none";
}

/**
 * Debug/e2e only (callers gate on the test-hook flag): keep only the files whose name contains one of the
 * comma-separated needles (case-insensitive). Lets the memory probe load 1, 2 or 3 models of one building.
 */
export function onlyNamed(files: readonly IfcFileListItem[], spec: string | null): IfcFileListItem[] {
  const needles = (spec ?? "").split(",").map((n) => n.trim().toLowerCase()).filter(Boolean);
  if (needles.length === 0) return [...files];
  return files.filter((f) => needles.some((n) => f.file.name.toLowerCase().includes(n)));
}
