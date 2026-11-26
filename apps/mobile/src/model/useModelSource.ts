import { useEffect, useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { isDemoAuth } from "@ff/auth";
import type { IfcFileListItem } from "@ff/viewer-react";
import { getDownloadedModelSource } from "../offline/instance";
import { testHooksEnabled } from "../dev/flag";
import { timedReader } from "./loadMarks";
import { resolveSource, toFileItems } from "./sourceLogic";
import { installSample, readFragBlob, sampleFiles, sampleModels, type SampleModel } from "./useSampleModel";

export type ModelSource =
  | { status: "loading" }
  | { status: "none" }
  | { status: "error"; error: string }
  | {
      status: "ready";
      kind: "downloaded" | "sample";
      files: IfcFileListItem[];
      /** `.frag` bytes per file id where known (orders the progressive load, smallest first). */
      sizes: Map<string, number>;
      modelIds: Set<string>;
      installMs?: number;
    };

export const getFragBlob = testHooksEnabled() ? timedReader(readFragBlob) : readFragBlob;

export function useModelSource(buildingId: string): ModelSource {
  const models = useLiveQuery(() => getDownloadedModelSource().list(buildingId), [buildingId]);
  const demo = isDemoAuth();
  const kind = resolveSource(models, demo);
  const [sample, setSample] = useState<{ buildingId: string; installMs?: number; models?: SampleModel[]; error?: string } | null>(null);

  useEffect(() => {
    if (kind !== "sample") return;
    let live = true;
    Promise.all([installSample(), sampleModels()]).then(
      ([installMs, models]) => live && setSample({ buildingId, installMs, models }),
      (e: unknown) => live && setSample({ buildingId, error: String((e as Error)?.message ?? e) }),
    );
    return () => {
      live = false;
    };
  }, [kind, buildingId]);

  return useMemo<ModelSource>(() => {
    if (kind === "loading") return { status: "loading" };
    if (kind === "none") return { status: "none" };
    if (kind === "downloaded") {
      const files = toFileItems(models!);
      const sizes = new Map<string, number>();
      for (const m of models!) if (m.version.fragSizeBytes) sizes.set(m.file.id, m.version.fragSizeBytes);
      return { status: "ready", kind, files, sizes, modelIds: new Set(files.map((f) => f.file.id)) };
    }
    if (!sample || sample.buildingId !== buildingId) return { status: "loading" };
    if (sample.error) return { status: "error", error: sample.error };
    const files = sampleFiles(buildingId, sample.models ?? []);
    const sizes = new Map((sample.models ?? []).map((m) => [m.fileId, m.size] as const));
    return { status: "ready", kind, files, sizes, modelIds: new Set(files.map((f) => f.file.id)), installMs: sample.installMs };
  }, [kind, models, sample, buildingId]);
}
