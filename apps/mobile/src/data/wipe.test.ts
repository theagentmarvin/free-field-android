// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { db } from "@ff/data/db/database";
import { MemoryBlobStore } from "../storage";
import { countUnsyncedOutbox, wipeLocalData, type WipeDeps } from "./wipe";

function deps(over: Partial<WipeDeps> = {}): WipeDeps & { deleted: string[]; removed: string[] } {
  const deleted: string[] = [];
  const removed: string[] = [];
  return {
    deleted,
    removed,
    closeConnections: async () => undefined,
    listDatabases: async () => ["free-field", "firestore/[DEFAULT]/x/main"],
    deleteDatabase: async (n) => void deleted.push(n),
    blobStore: new MemoryBlobStore(),
    localStorageKeys: () => ["ff-project-choice", "ffm-session", "emailForSignIn", "unrelated"],
    removeLocalStorageKey: (k) => void removed.push(k),
    ...over,
  };
}

describe("wipeLocalData", () => {
  it("deletes every database, every blob and our local keys only", async () => {
    const d = deps();
    await d.blobStore.write("frag/a.frag", new Uint8Array([1, 2]));
    await d.blobStore.write("pdf/b.pdf", new Uint8Array([3]));
    const r = await wipeLocalData(d);
    expect(r).toEqual({ databases: ["free-field", "firestore/[DEFAULT]/x/main"], blobs: 2, prefs: 3, errors: [] });
    expect(d.deleted).toHaveLength(2);
    expect(await d.blobStore.list()).toEqual([]);
    expect(d.removed.sort()).toEqual(["emailForSignIn", "ff-project-choice", "ffm-session"]);
  });
  it("closes connections before deleting databases", async () => {
    const order: string[] = [];
    const d = deps({
      closeConnections: async () => void order.push("close"),
      deleteDatabase: async () => void order.push("delete"),
    });
    await wipeLocalData(d);
    expect(order[0]).toBe("close");
  });
  it("keeps going and reports when one step fails", async () => {
    const d = deps({
      deleteDatabase: vi.fn(async (n: string) => {
        if (n === "free-field") throw new Error("blocked");
      }),
    });
    await d.blobStore.write("frag/a.frag", new Uint8Array([1]));
    const r = await wipeLocalData(d);
    expect(r.errors).toEqual(["db free-field: blocked"]);
    expect(r.databases).toEqual(["firestore/[DEFAULT]/x/main"]);
    expect(r.blobs).toBe(1);
  });
});

describe("countUnsyncedOutbox", () => {
  it("counts added, sending and failed rows across projects, not sent or killed", async () => {
    await db.outbox.clear();
    const base = { kind: "task-action" as const, payload: {}, photoRefs: [], attempts: 0, createdAt: 1 };
    await db.outbox.bulkAdd(
      (["added", "sending", "failed", "sent", "killed"] as const).map((state, i) => ({
        ...base,
        id: `r${i}`,
        clientGuid: `r${i}`,
        state,
        projectId: i % 2 ? "p1" : "p2",
      })),
    );
    expect(await countUnsyncedOutbox()).toBe(3);
  });
});
