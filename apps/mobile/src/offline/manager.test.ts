import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFiles, bytes, makeRows, serve, sha, type Fixture } from "./fakes";
import { OfflineDb } from "./journal";
import { DownloadManager, type ManagerDeps } from "./manager";
import { buildPlan, estimateBytes, summarize } from "./plan";
import { OfflineRefusal, type NetworkInfo, type OfflineSettings, type PlanDownloadedEvent } from "./types";

const tick = () => new Promise((r) => setTimeout(r, 20));
let n = 0;
let files: FakeFiles;
let fx: Fixture;
let journal: OfflineDb;
let net: NetworkInfo;
let settings: OfflineSettings;
let events: PlanDownloadedEvent[];
let rowsNow: () => Fixture["rows"];

function mk(extra: Partial<ManagerDeps> = {}): DownloadManager {
  return new DownloadManager({
    journal,
    files,
    urlFor: async (p) => ({ url: `https://dl/${p}` }),
    loadRows: async () => rowsNow(),
    buildingName: async () => "Tower",
    network: () => net,
    settings: () => settings,
    persistEveryMs: 0,
    onPlanDownloaded: (e) => events.push(e),
    ...extra,
  });
}

beforeEach(() => {
  journal = new OfflineDb(`t-${++n}`);
  files = new FakeFiles();
  fx = makeRows();
  rowsNow = () => fx.rows;
  serve(files, fx);
  net = { online: true, connectionType: "wifi" };
  settings = { wifiOnly: true, autoUpdate: true };
  events = [];
});

describe("plan and size estimate", () => {
  it("takes the newest frag, every pdf revision (newest first) and never IFC", () => {
    const rows = makeRows({ fragVersion: 2 }).rows;
    // add an older version with a frag and a newer one without
    rows.ifcVersions.push({ ...rows.ifcVersions[0], id: "old", versionNumber: 1, fragStoragePath: "projects/p1/frag/old.frag" });
    rows.ifcVersions.push({ ...rows.ifcVersions[0], id: "nofrag", versionNumber: 3, fragStoragePath: null, fragSha256: null, fragSizeBytes: null });
    rows.pdfVersions.push({ ...rows.pdfVersions[0], id: "pv0", versionNumber: 0 });
    const plan = buildPlan(rows);
    expect(plan.map((p) => p.id).sort()).toEqual(["frag:iv2", "pdf:pv0", "pdf:pv1"]);
    // the newest revision of a plan is queued before its older ones
    expect(plan.filter((p) => p.kind === "pdf").map((p) => p.id)).toEqual(["pdf:pv1", "pdf:pv0"]);
    expect(plan.every((p) => !p.storagePath.endsWith(".ifc"))).toBe(true);
    expect(estimateBytes(plan)).toBe(5000 + 2500 * 2);
  });

  it("estimates remaining bytes and drops finished items", async () => {
    const m = mk();
    expect(await m.estimate("b1")).toEqual({ items: 2, bytes: 7500, remainingBytes: 7500 });
    await m.start("b1", "proj");
    await m.idle();
    expect(await m.estimate("b1")).toEqual({ items: 2, bytes: 7500, remainingBytes: 0 });
  });
});

describe("download, verify, commit", () => {
  it("streams both files, verifies sha256 + size, fires the plan hook and keeps the screen awake meanwhile", async () => {
    const m = mk();
    await m.start("b1", "proj");
    await m.idle();
    expect(files.finals.get("frag/f1__v1.frag")).toEqual(fx.frag);
    expect(files.finals.get("pdf/p1__v1.pdf")).toEqual(fx.pdf);
    expect(files.parts.size).toBe(0);
    const items = await journal.items.toArray();
    expect(items.every((i) => i.status === "done" && i.bytesDone === i.size)).toBe(true);
    expect(summarize(await journal.packages.get("b1"), items).state).toBe("ready");
    expect(events).toEqual([expect.objectContaining({ buildingId: "b1", pdfFileId: "p1", versionId: "pv1", key: "pdf/p1__v1.pdf", sha256: sha(fx.pdf) })]);
    expect(files.awake).toEqual([true, false]);
    expect(files.requests.some((r) => r.url.endsWith(".ifc"))).toBe(false);
  });

  it("integrity failure: error shown, no part and no file kept, hook not fired; retry succeeds after the source is fixed", async () => {
    const bad = bytes(2500);
    files.remote.set("https://dl/projects/p1/pdf/pv1.pdf", bad); // different bytes, same size
    const m = mk();
    await m.start("b1", "proj");
    await m.idle();
    const pdf = (await journal.items.get("pdf:pv1"))!;
    expect(pdf.status).toBe("error");
    expect(pdf.errorKind).toBe("integrity");
    expect(pdf.error).toMatch(/Integrity check failed/);
    expect(files.parts.has("pdf/p1__v1.pdf")).toBe(false);
    expect(files.finals.has("pdf/p1__v1.pdf")).toBe(false);
    expect(events).toEqual([]);
    expect(summarize(await journal.packages.get("b1"), await journal.items.toArray()).state).toBe("error");
    files.remote.set("https://dl/projects/p1/pdf/pv1.pdf", fx.pdf);
    await m.retryFailed("b1");
    await m.idle();
    expect((await journal.items.get("pdf:pv1"))!.status).toBe("done");
    expect(events).toHaveLength(1);
  });

  it("size mismatch is an integrity failure too", async () => {
    files.remote.set("https://dl/projects/p1/pdf/pv1.pdf", fx.pdf.subarray(0, 2000));
    // journal expects 2500 bytes: the download ends short
    const m = mk();
    await m.start("b1", "proj");
    await m.idle();
    const pdf = (await journal.items.get("pdf:pv1"))!;
    expect(pdf.status).toBe("error");
    expect(pdf.errorKind).toBe("integrity");
    expect(files.finals.has("pdf/p1__v1.pdf")).toBe(false);
  });
});

describe("journal and resume after a kill", () => {
  it("continues from the partial file with a Range offset and finishes with a correct hash", async () => {
    // First process: dies (throws a network error) once 3000 bytes of the model are on disk.
    files.afterChunk = (key, size) => {
      if (key.startsWith("frag/") && size >= 3000) throw new Error("network connection reset");
    };
    const first = mk({ concurrency: 1 });
    await first.start("b1", "proj");
    await first.idle();
    const mid = (await journal.items.get("frag:iv1"))!;
    expect(mid.status).toBe("error");
    expect(mid.errorKind).toBe("network");
    expect(mid.bytesDone).toBe(3000);
    expect(files.parts.get("frag/f1__v1.frag")!.length).toBe(3000);

    // "Relaunch": a fresh manager over the same journal and files picks it up.
    files.afterChunk = undefined;
    files.requests = [];
    const second = mk();
    await second.setProject("proj");
    await second.idle();
    expect(files.requests).toEqual([{ url: "https://dl/projects/p1/frag/iv1.frag", offset: 3000 }]);
    expect(files.finals.get("frag/f1__v1.frag")).toEqual(fx.frag);
    expect((await journal.items.get("frag:iv1"))!.status).toBe("done");
  });

  it("recovers items left in 'downloading' by a hard kill (journal says downloading, part on disk)", async () => {
    await journal.packages.put({ buildingId: "b1", projectId: "proj", name: "Tower", pausedBy: null, updateAvailable: false, createdAt: 1, updatedAt: 1 });
    const plan = buildPlan(fx.rows);
    for (const p of plan) await journal.items.put({ ...p, projectId: "proj", buildingId: "b1", status: "downloading", bytesDone: 0, updatedAt: 1 });
    files.parts.set("pdf/p1__v1.pdf", fx.pdf.slice(0, 1200));
    const m = mk();
    await m.setProject("proj");
    await m.idle();
    expect(files.requests.find((r) => r.url.endsWith("pv1.pdf"))!.offset).toBe(1200);
    expect((await journal.items.toArray()).every((i) => i.status === "done")).toBe(true);
  });

  it("a part larger than the expected size is discarded and restarted", async () => {
    files.parts.set("pdf/p1__v1.pdf", bytes(9999));
    const m = mk();
    await m.start("b1", "proj");
    await m.idle();
    expect(files.requests.find((r) => r.url.endsWith("pv1.pdf"))!.offset).toBe(0);
    expect(files.finals.get("pdf/p1__v1.pdf")).toEqual(fx.pdf);
  });

  it("user pause survives a relaunch (no auto resume) until Resume", async () => {
    files.afterChunk = async (key, size) => {
      if (key.startsWith("frag/") && size >= 2000) { void m.pause("b1"); await tick(); }
    };
    const m = mk({ concurrency: 1 });
    await m.start("b1", "proj");
    await m.idle();
    const pkg = await journal.packages.get("b1");
    expect(pkg!.pausedBy).toBe("user");
    expect(summarize(pkg, await journal.items.toArray()).state).toBe("paused");
    files.afterChunk = undefined;
    const second = mk();
    await second.setProject("proj");
    await second.idle();
    expect(files.finals.has("frag/f1__v1.frag")).toBe(false);
    await second.resume("b1");
    await second.idle();
    expect(files.finals.get("frag/f1__v1.frag")).toEqual(fx.frag);
  });
});

describe("gating", () => {
  it("Wi-Fi only refuses on cellular, allows on Wi-Fi, and is bypassed when the setting is off", async () => {
    const m = mk();
    net = { online: true, connectionType: "cellular" };
    await expect(m.start("b1", "proj")).rejects.toMatchObject({ code: "wifi-only" });
    expect(await journal.items.count()).toBe(0);
    settings = { wifiOnly: false, autoUpdate: true };
    await m.start("b1", "proj");
    await m.idle();
    expect((await journal.items.toArray()).every((i) => i.status === "done")).toBe(true);
  });

  it("refuses while offline", async () => {
    net = { online: false, connectionType: "none" };
    await expect(mk().start("b1", "proj")).rejects.toMatchObject({ code: "offline" });
  });

  it("pauses running downloads when Wi-Fi is lost and resumes when it is back", async () => {
    let swapped = false;
    files.afterChunk = async (key, size) => {
      if (!swapped && key.startsWith("frag/") && size >= 2000) {
        swapped = true;
        net = { online: true, connectionType: "cellular" };
        void m.onNetworkChange();
        await tick();
      }
    };
    const m = mk({ concurrency: 1 });
    await m.setProject("proj");
    await m.start("b1", "proj");
    await m.idle();
    expect((await journal.packages.get("b1"))!.pausedBy).toBe("network");
    expect(files.finals.has("frag/f1__v1.frag")).toBe(false);
    files.afterChunk = undefined;
    net = { online: true, connectionType: "wifi" };
    await m.onNetworkChange();
    await m.idle();
    expect(files.finals.get("frag/f1__v1.frag")).toEqual(fx.frag);
    expect((await journal.packages.get("b1"))!.pausedBy).toBeNull();
  });

  it("low storage refuses before anything is written and explains the numbers", async () => {
    files.free = 10 * 1024 * 1024; // 10 MB free, needs 7.5 KB + 50 MB headroom
    const m = mk();
    const err = await m.start("b1", "proj").catch((e) => e);
    expect(err).toBeInstanceOf(OfflineRefusal);
    expect(err.code).toBe("low-storage");
    expect(err.message).toMatch(/Not enough free space/);
    expect(await journal.items.count()).toBe(0);
    expect(await journal.packages.count()).toBe(0);
    expect(files.requests).toEqual([]);
    files.free = 500 * 1024 * 1024;
    await m.start("b1", "proj");
    await m.idle();
    expect(files.finals.size).toBe(2);
  });

  it("counts already-downloaded part bytes as not needed", async () => {
    files.parts.set("frag/f1__v1.frag", fx.frag.slice(0, 4000));
    files.free = 50 * 1024 * 1024 + 1000 + 2500 + 100;
    const m = mk();
    await m.start("b1", "proj"); // needs 1000 + 2500 + max(50MB, 5%) -> fits
    await m.idle();
    expect(files.finals.size).toBe(2);
  });
});

describe("project switch", () => {
  it("stops downloads of the previous project (parts kept) and resumes them when the project returns", async () => {
    files.afterChunk = async (key, size) => {
      if (key.startsWith("frag/") && size >= 2000 && stopOnce) {
        stopOnce = false;
        void m.setProject("other");
        await tick();
      }
    };
    let stopOnce = true;
    const m = mk({ concurrency: 1 });
    await m.setProject("proj");
    await m.start("b1", "proj");
    await m.idle();
    expect((await journal.items.get("frag:iv1"))!.status).toBe("queued");
    expect(files.finals.has("frag/f1__v1.frag")).toBe(false);
    expect(files.parts.get("frag/f1__v1.frag")!.length).toBeGreaterThanOrEqual(2000);
    files.afterChunk = undefined;
    files.requests = [];
    await m.setProject("proj");
    await m.idle();
    expect(files.requests[0].offset).toBeGreaterThanOrEqual(2000);
    expect(files.finals.get("frag/f1__v1.frag")).toEqual(fx.frag);
  });

  it("does not resume another project's packages", async () => {
    await journal.packages.put({ buildingId: "b9", projectId: "other", name: "X", pausedBy: null, updateAvailable: false, createdAt: 1, updatedAt: 1 });
    const plan = buildPlan(fx.rows);
    await journal.items.put({ ...plan[0], id: "frag:zz", projectId: "other", buildingId: "b9", status: "queued", bytesDone: 0, updatedAt: 1 });
    const m = mk();
    await m.setProject("proj");
    await m.idle();
    expect(files.requests).toEqual([]);
  });
});

describe("cancel, remove, updates", () => {
  it("cancel deletes partial files; remove deletes finished files and rows", async () => {
    let cancelP: Promise<void> | undefined;
    files.afterChunk = async (key, size) => {
      if (key.startsWith("frag/") && size >= 2000) cancelP = m.cancel("b1");
      await tick();
    };
    const m = mk({ concurrency: 1 });
    await m.start("b1", "proj");
    await m.idle();
    await cancelP;
    files.afterChunk = undefined;
    expect(files.parts.size).toBe(0);
    expect(files.finals.has("frag/f1__v1.frag")).toBe(false);
    expect(await journal.items.get("frag:iv1")).toBeUndefined();
    expect((await journal.items.get("pdf:pv1"))!.status).toBe("done"); // finished files survive a cancel
    await m.start("b1", "proj");
    await m.idle();
    expect(files.finals.size).toBe(2);
    await m.remove("b1");
    expect(files.finals.size).toBe(0);
    expect(await journal.items.count()).toBe(0);
    expect(await journal.packages.count()).toBe(0);
  });

  it("flags a newer version, auto-updates on Wi-Fi, and removes the superseded files", async () => {
    const m = mk();
    await m.setProject("proj");
    await m.start("b1", "proj");
    await m.idle();
    expect(await m.checkUpdates()).toEqual([]);

    const v2 = makeRows({ fragVersion: 2, pdf: fx.pdf, pdfVersion: 1 });
    rowsNow = () => v2.rows;
    serve(files, v2);
    settings = { wifiOnly: true, autoUpdate: false };
    expect(await m.checkUpdates()).toEqual(["b1"]);
    expect((await journal.packages.get("b1"))!.updateAvailable).toBe(true);
    expect(summarize(await journal.packages.get("b1"), await journal.items.toArray()).state).toBe("update-available");
    expect(files.finals.has("frag/f1__v1.frag")).toBe(true); // untouched until the update runs

    settings = { wifiOnly: true, autoUpdate: true };
    net = { online: true, connectionType: "cellular" };
    await m.checkUpdates();
    await m.idle();
    expect(files.finals.has("frag/f1__v2.frag")).toBe(false); // not on Wi-Fi: no auto update

    net = { online: true, connectionType: "wifi" };
    await m.checkUpdates();
    await m.idle();
    expect(files.finals.get("frag/f1__v2.frag")).toEqual(v2.frag);
    expect(files.finals.has("frag/f1__v1.frag")).toBe(false);
    expect((await journal.packages.get("b1"))!.updateAvailable).toBe(false);
    expect(await journal.items.get("frag:iv1")).toBeUndefined();
  });

  it("nothing to download is a refusal, not an empty package", async () => {
    rowsNow = () => ({ ifcFiles: [], ifcVersions: [], pdfFiles: [], pdfVersions: [] });
    await expect(mk().start("b1", "proj")).rejects.toMatchObject({ code: "nothing-to-download" });
  });
});

describe("plan hook isolation", () => {
  it("a throwing hook never fails the download", async () => {
    const log = vi.fn();
    const m = mk({ onPlanDownloaded: () => { throw new Error("renderer down"); }, log });
    await m.start("b1", "proj");
    await m.idle();
    expect((await journal.items.toArray()).every((i) => i.status === "done")).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("renderer down"));
  });
});
