import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { FakeFiles, makeRows, serve } from "./fakes";
import { OfflineDb } from "./journal";
import { DownloadManager } from "./manager";
import { createMobileBlobSink } from "./engineBridge";
import { DownloadedModelSource, DownloadedPlanSource, onPlanDownloaded, emitPlanDownloaded } from "./sources";
import { readSettings, writeSettings } from "./settings";

describe("sources and hooks", () => {
  it("lists downloaded plans/models with local keys once the files landed", async () => {
    const journal = new OfflineDb("src-1");
    const files = new FakeFiles();
    const fx = makeRows();
    serve(files, fx);
    const m = new DownloadManager({
      journal,
      files,
      urlFor: async (p) => ({ url: `https://dl/${p}` }),
      loadRows: async () => fx.rows,
      buildingName: async () => "T",
      network: () => ({ online: true, connectionType: "wifi" }),
      settings: () => ({ wifiOnly: true, autoUpdate: true }),
      persistEveryMs: 0,
    });
    const plans = new DownloadedPlanSource({
      journal,
      rows: {
        pdfFiles: async () => fx.rows.pdfFiles,
        pdfVersions: async () => fx.rows.pdfVersions,
        storeys: async () => [],
        folders: async () => [],
        folderAssignments: async () => [],
      },
    });
    const models = new DownloadedModelSource({ journal, ifcFiles: async () => fx.rows.ifcFiles, ifcVersion: async (id) => fx.rows.ifcVersions.find((v) => v.id === id) });
    expect((await plans.listPlans("b1"))[0].downloaded).toBeNull();
    expect(await models.getLocalFragKey("b1")).toBeNull();
    await m.start("b1", "proj");
    await m.idle();
    const [plan] = await plans.listPlans("b1");
    expect(plan.downloaded).toMatchObject({ localKey: "pdf/p1__v1.pdf", localPath: "blobs/pdf/p1__v1.pdf" });
    expect(await models.getLocalFragKey("b1")).toBe("frag/f1__v1.frag");
    await m.remove("b1");
    expect(await models.getLocalFragKey("b1")).toBeNull();
  });

  it("downloads every revision of a plan and lists each one with its local key", async () => {
    const journal = new OfflineDb("src-rev");
    const files = new FakeFiles();
    const fx = makeRows({ pdfVersion: 2 });
    fx.rows.pdfVersions[0].isLatest = true;
    fx.rows.pdfVersions.push({ ...fx.rows.pdfVersions[0], id: "pv1", versionNumber: 1, blobKey: "p1__v1", isLatest: false, storagePath: "projects/p1/pdf/pv1.pdf" });
    serve(files, fx);
    const m = new DownloadManager({
      journal,
      files,
      urlFor: async (p) => ({ url: `https://dl/${p}` }),
      loadRows: async () => fx.rows,
      buildingName: async () => "T",
      network: () => ({ online: true, connectionType: "wifi" }),
      settings: () => ({ wifiOnly: true, autoUpdate: true }),
      persistEveryMs: 0,
    });
    const plans = new DownloadedPlanSource({
      journal,
      rows: {
        pdfFiles: async () => fx.rows.pdfFiles,
        pdfVersions: async () => fx.rows.pdfVersions,
        storeys: async () => [],
        folders: async () => [],
        folderAssignments: async () => [],
      },
    });
    const before = (await plans.listPlans("b1"))[0];
    expect(before.versions.map((v) => [v.version.versionNumber, v.localKey])).toEqual([[2, null], [1, null]]);
    await m.start("b1", "proj");
    await m.idle();
    const [plan] = await plans.listPlans("b1");
    expect(plan.versions.map((v) => [v.version.versionNumber, v.localKey])).toEqual([[2, "pdf/p1__v2.pdf"], [1, "pdf/p1__v1.pdf"]]);
    expect(plan.downloaded?.version.versionNumber).toBe(2);
    expect(files.finals.has("pdf/p1__v1.pdf")).toBe(true); // verified like the latest one
    // a package that only has the latest revision (older app version) reports the older one as pending
    await files.remove("pdf/p1__v1.pdf");
    await journal.items.delete("pdf:pv1");
    expect((await m.estimate("b1")).remainingBytes).toBe(2500);
  });

  it("onPlanDownloaded delivers to every hook, survives a throwing one and unsubscribes", async () => {
    const a = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const off = onPlanDownloaded(a);
    const off2 = onPlanDownloaded(() => {
      throw new Error("x");
    });
    const e = { projectId: "p", buildingId: "b", pdfFileId: "f", versionId: "v", versionNumber: 1, key: "pdf/v.pdf", sha256: "s", size: 1 };
    emitPlanDownloaded(e);
    expect(a).toHaveBeenCalledWith(e);
    off();
    off2();
    emitPlanDownloaded(e);
    expect(a).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("engine BlobSink: has/put via files; adopts nothing for IFC", async () => {
    const files = new FakeFiles();
    files.finals.set("frag/k.frag", new Uint8Array(3));
    const sink = createMobileBlobSink(files);
    expect(await sink.has("frag", "k")).toBe(true);
    expect(await sink.has("pdf", "k")).toBe(false);
    expect(await sink.has("ifc", "k")).toBe(false);
    await sink.put("ifc", "k", new Blob([new Uint8Array(1)]));
    expect(files.finals.size).toBe(1);
  });

  it("settings default to Wi-Fi only + auto update and persist", () => {
    const store = new Map<string, string>();
    const kv = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    expect(readSettings(kv)).toEqual({ wifiOnly: true, autoUpdate: true });
    writeSettings({ wifiOnly: false }, kv);
    expect(readSettings(kv)).toEqual({ wifiOnly: false, autoUpdate: true });
  });
});
