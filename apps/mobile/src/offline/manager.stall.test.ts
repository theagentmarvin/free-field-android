import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFiles, makeRows, serve, type Fixture } from "./fakes";
import { OfflineDb } from "./journal";
import { DownloadManager, LOW_FREE_BYTES, STORAGE_FULL_MESSAGE, type ManagerDeps } from "./manager";
import { summarize } from "./plan";

let n = 0;
let files: FakeFiles;
let fx: Fixture;
let journal: OfflineDb;
let clock: number;
let reach: boolean[];

const FRAG = "frag/f1__v1.frag";

function mk(extra: Partial<ManagerDeps> = {}): DownloadManager {
  return new DownloadManager({
    journal,
    files,
    urlFor: async (p) => ({ url: `https://dl/${p}` }),
    loadRows: async () => fx.rows,
    buildingName: async () => "Tower",
    network: () => ({ online: true, connectionType: "wifi" }),
    settings: () => ({ wifiOnly: false, autoUpdate: false }),
    persistEveryMs: 0,
    now: () => clock,
    stallMs: 1000,
    onReachability: (ok) => reach.push(ok),
    ...extra,
  });
}

/** Make the model's transfer hang once 3000 bytes are on disk; `release` ends the hung call with an error (late native failure). */
function hangFrag(): { release: () => void } {
  let release!: () => void;
  const stuck = new Promise<void>((_, rej) => {
    release = () => rej(new Error("write failed: ENOSPC"));
  });
  files.afterChunk = (key, size) => {
    if (key === FRAG && size >= 3000) return stuck;
  };
  return { release };
}

const waitFor = async (cond: () => Promise<boolean> | boolean) => {
  for (let i = 0; i < 200; i++) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("condition not met");
};

beforeEach(() => {
  journal = new OfflineDb(`stall-${++n}`);
  files = new FakeFiles();
  fx = makeRows();
  serve(files, fx);
  clock = 1_000_000;
  reach = [];
});

describe("stall watchdog", () => {
  it("aborts a transfer that moved no bytes, reports storage when the disk is full, and keeps verified files and the part", async () => {
    const hung = hangFrag();
    const m = mk();
    await m.start("b1", "proj");
    await waitFor(async () => (await journal.items.get("pdf:pv1"))?.status === "done" && (files.parts.get(FRAG)?.length ?? 0) >= 3000);
    files.free = 1024 * 1024;
    expect(await m.checkStalls()).toEqual([]); // not yet stalled
    clock += 2000;
    expect(await m.checkStalls()).toEqual(["frag:iv1"]);
    const frag = (await journal.items.get("frag:iv1"))!;
    expect(frag.status).toBe("error");
    expect(frag.errorKind).toBe("storage");
    expect(frag.error).toBe(STORAGE_FULL_MESSAGE);
    expect(summarize(await journal.packages.get("b1"), await journal.items.toArray()).state).toBe("error");
    // verified plan and the partial model are untouched
    expect(files.finals.get("pdf/p1__v1.pdf")).toEqual(fx.pdf);
    expect(files.parts.get(FRAG)!.length).toBe(3000);
    // the hung native call finally fails: its late result must not overwrite the recorded outcome
    hung.release();
    await m.idle();
    expect((await journal.items.get("frag:iv1"))!.error).toBe(STORAGE_FULL_MESSAGE);
  });

  it("reports a network stall (plenty of space) as a network error and tells reachability", async () => {
    hangFrag();
    const m = mk();
    await m.start("b1", "proj");
    await waitFor(() => (files.parts.get(FRAG)?.length ?? 0) >= 3000);
    clock += 2000;
    await m.checkStalls();
    const frag = (await journal.items.get("frag:iv1"))!;
    expect(frag.errorKind).toBe("network");
    expect(frag.error).toMatch(/stalled/);
    expect(reach).toContain(false);
  });

  it("does not fire while bytes keep moving, however long the whole download takes", async () => {
    const m = mk();
    files.afterChunk = async () => {
      clock += 100; // two items interleave: each still moves within the limit, the total is far over it
      expect(await m.checkStalls()).toEqual([]);
    };
    await m.start("b1", "proj");
    await m.idle();
    expect((await journal.items.toArray()).every((i) => i.status === "done")).toBe(true);
  });

  it("holds the failed state in memory when the journal cannot be written, and Retry works without a restart", async () => {
    const hung = hangFrag();
    const m = mk();
    await m.start("b1", "proj");
    await waitFor(() => (files.parts.get(FRAG)?.length ?? 0) >= 3000);
    files.free = 1024 * 1024; // the disk fills while the transfer is running
    // From here on the journal rejects every write (IndexedDB broken after ENOSPC) but still reads.
    const boom = () => Promise.reject(new Error("UnknownError: Internal error opening backing store for indexedDB.open"));
    const spies = [vi.spyOn(journal.items, "update").mockImplementation(boom as never), vi.spyOn(journal.items, "put").mockImplementation(boom as never)];
    clock += 2000;
    await m.checkStalls();
    // journal still says "downloading", memory says failed with the storage message
    expect((await journal.items.get("frag:iv1"))!.status).toBe("downloading");
    const snap = await m.snapshot("proj");
    const frag = snap.items.find((i) => i.id === "frag:iv1")!;
    expect(frag.status).toBe("error");
    expect(frag.errorKind).toBe("storage");
    expect(summarize(snap.pkgs[0], snap.items).state).toBe("error");
    hung.release();
    await m.idle();

    // Retry while the disk is still full: refused with a clear message, nothing restarted
    await expect(m.retryFailed("b1")).rejects.toMatchObject({ code: "low-storage" });
    expect(files.requests.filter((r) => r.url.endsWith("iv1.frag"))).toHaveLength(1);

    // Space freed: Retry resumes from the partial file (Range offset 3000) and completes, no restart
    files.free = LOW_FREE_BYTES * 10;
    files.afterChunk = undefined;
    await m.retryFailed("b1");
    await m.idle();
    expect(files.requests.at(-1)).toEqual({ url: "https://dl/projects/p1/frag/iv1.frag", offset: 3000 });
    expect(files.finals.get(FRAG)).toEqual(fx.frag);
    const after = await m.snapshot("proj");
    expect(after.items.find((i) => i.id === "frag:iv1")!.status).toBe("done");
    spies.forEach((s) => s.mockRestore());
  });

  it("a persist failure during progress does not become an unhandled rejection or stop the transfer", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    vi.spyOn(journal.items, "update").mockImplementation((() => Promise.reject(new Error("write failed: ENOSPC"))) as never);
    const m = mk();
    await m.start("b1", "proj");
    await m.idle();
    await new Promise((r) => setTimeout(r, 20));
    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
    expect(files.finals.get(FRAG)).toEqual(fx.frag);
  });

  it("stallMs 0 turns the watchdog off", async () => {
    hangFrag();
    const m = mk({ stallMs: 0 });
    await m.start("b1", "proj");
    await waitFor(() => (files.parts.get(FRAG)?.length ?? 0) >= 3000);
    clock += 10_000_000;
    expect(await m.checkStalls()).toEqual([]);
  });
});
