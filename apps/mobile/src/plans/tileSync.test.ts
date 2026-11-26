import { describe, expect, it, vi } from "vitest";
import type { PdfFileRecord, PdfVersionRecord } from "@ff/types";
import { MemoryBlobStore } from "../storage";
import type { DownloadedPlan } from "../offline/sources";
import { PlanTileSync, blobKeyOfPdfKey, refFromEvent, type TileSyncDeps } from "./tileSync";
import { tileKey } from "./manifest";
import type { TileState } from "./tileService";

const file = (id: string): PdfFileRecord => ({ id, buildingId: "b1", name: `Plan ${id}`, createdAt: 0, updatedAt: 0 });
const ver = (id: string, pdfFileId: string, n: number): PdfVersionRecord =>
  ({ id, pdfFileId, versionNumber: n, name: "x.pdf", size: 1, contentHash: "h", pageCount: 1, width: 1, height: 1, storedAt: 0, blobKey: `blob-${id}`, isLatest: false, sha256: `sha-${id}` }) as PdfVersionRecord;

async function setup(plans: DownloadedPlan[], states: Record<string, TileState["state"]> = {}) {
  const store = new MemoryBlobStore();
  const ensure = vi.fn(async () => undefined);
  const versions: Record<string, string[]> = { f1: ["v1", "v2"], f2: ["w1"] };
  const deps: TileSyncDeps = {
    tiles: { ensureTiles: ensure, status: async (id) => ({ state: states[id] ?? "none" }) as TileState },
    store,
    listPlans: async () => plans,
    versionIds: async (f) => versions[f] ?? [],
    planName: async (f) => `Plan ${f}`,
  };
  for (const v of ["v1", "v2", "w1"]) await store.write(tileKey(v, 0, 0, 0), new Uint8Array([1]));
  return { sync: new PlanTileSync(deps), store, ensure };
}
const onDisk = (v: PdfVersionRecord) => ({ version: v, localKey: `pdf/${v.blobKey}.pdf`, localPath: `blobs/pdf/${v.blobKey}.pdf` });
/** `extra`: older revisions that are on the device too. */
const dl = (f: PdfFileRecord, v: PdfVersionRecord | null, extra: PdfVersionRecord[] = []): DownloadedPlan => ({
  file: f,
  folderId: null,
  downloaded: v ? onDisk(v) : null,
  versions: [...(v ? [onDisk(v)] : []), ...extra.map(onDisk)],
});
const event = { projectId: "p", buildingId: "b1", pdfFileId: "f1", versionId: "v2", versionNumber: 2, key: "pdf/blob-v2.pdf", sha256: "sha-v2", size: 1 };

describe("tile sync", () => {
  it("maps a download event to a render ref (key -> blobKey, sha carried)", () => {
    expect(blobKeyOfPdfKey("pdf/abc__v1.pdf")).toBe("abc__v1");
    expect(refFromEvent(event, "S-101")).toEqual({ planVersionId: "v2", pdfFileId: "f1", blobKey: "blob-v2", name: "S-101", sha256: "sha-v2" });
  });

  it("renders the newest revision at download time and keeps the tiles of older revisions", async () => {
    const { sync, store, ensure } = await setup([]);
    await sync.onDownloaded(event);
    expect(ensure).toHaveBeenCalledWith(expect.objectContaining({ planVersionId: "v2", blobKey: "blob-v2", name: "Plan f1" }));
    expect((await store.list("tiles/v1/")).length).toBe(1); // older revisions stay on the device with their tiles
    expect((await store.list("tiles/v2/")).length).toBe(1);
    expect((await store.list("tiles/w1/")).length).toBe(1); // other plans untouched
  });

  it("does not render an older revision at download time (it is tiled when opened or compared)", async () => {
    const { store } = await setup([]);
    const ensure = vi.fn(async () => undefined);
    const sync = new PlanTileSync({
      tiles: { ensureTiles: ensure, status: async () => ({ state: "none" }) as TileState },
      store,
      listPlans: async () => [],
      versionIds: async () => ["v1", "v2"],
      isNewest: async (_f, v) => v === "v2",
    });
    await sync.onDownloaded({ ...event, versionId: "v1", versionNumber: 1, key: "pdf/blob-v1.pdf", sha256: "sha-v1" });
    expect(ensure).not.toHaveBeenCalled();
    await sync.onDownloaded(event);
    expect(ensure).toHaveBeenCalledTimes(1);
  });

  it("propagates a failed render of the newest revision and leaves older tiles alone", async () => {
    const { sync, store, ensure } = await setup([]);
    ensure.mockRejectedValueOnce(new Error("boom"));
    await expect(sync.onDownloaded(event)).rejects.toThrow("boom");
    expect((await store.list("tiles/v1/")).length).toBe(1);
  });

  it("reconcile renders missing/partial tiles of downloaded plans, skips ready, not-offline and failed ones", async () => {
    const f1 = file("f1");
    const f2 = file("f2");
    const { sync, ensure } = await setup([dl(f1, ver("v2", "f1", 2)), dl(f2, null)], { v2: "partial" });
    await sync.reconcile(["b1"]);
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(ensure).toHaveBeenCalledWith(expect.objectContaining({ planVersionId: "v2" }));

    const ready = await setup([dl(f1, ver("v2", "f1", 2))], { v2: "ready" });
    await ready.sync.reconcile(["b1"]);
    expect(ready.ensure).not.toHaveBeenCalled();
    const failed = await setup([dl(f1, ver("v2", "f1", 2))], { v2: "error" });
    await failed.sync.reconcile(["b1"]);
    expect(failed.ensure).not.toHaveBeenCalled();
  });

  it("reconcile keeps tiles of older revisions that are on the device", async () => {
    const f1 = file("f1");
    const { sync, store, ensure } = await setup([dl(f1, ver("v2", "f1", 2), [ver("v1", "f1", 1)])], { v2: "ready" });
    await sync.reconcile(["b1"]);
    expect((await store.list("tiles/v1/")).length).toBe(1);
    expect((await store.list("tiles/v2/")).length).toBe(1);
    expect(ensure).not.toHaveBeenCalled(); // older revisions are not rendered eagerly
  });

  it("reconcile drops tiles of versions that are not on the device (package removed, revision removed)", async () => {
    const f1 = file("f1");
    const f2 = file("f2");
    const { sync, store } = await setup([dl(f1, ver("v2", "f1", 2)), dl(f2, null)], { v2: "ready" });
    await sync.reconcile(["b1"]);
    expect((await store.list("tiles/v1/")).length).toBe(0);
    expect((await store.list("tiles/v2/")).length).toBe(1);
    expect((await store.list("tiles/w1/")).length).toBe(0); // f2 has no downloaded PDF any more
  });
});
