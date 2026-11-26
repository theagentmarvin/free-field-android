import { describe, expect, it } from "vitest";
import type { DraftTable } from "@ff/tasks";
import { emptyCompose } from "@ff/tasks-react";
import { deleteDraft, isWorthSaving, listDraftSummaries, loadCompose, saveCompose } from "./drafts";

function table(): DraftTable {
  const rows = new Map<string, { id: string; projectId: string; updatedAt: number; draft: Record<string, unknown> }>();
  return {
    get: async (id) => rows.get(id),
    put: async (r) => void rows.set(r.id, r),
    delete: async (id) => void rows.delete(id),
    whereProject: async (p) => [...rows.values()].filter((r) => r.projectId === p),
  };
}
const photo = { blobKey: "k1", sha256: "a".repeat(64), size: 10, mime: "image/jpeg" };

describe("drafts", () => {
  it("empty forms are not worth saving", () => {
    expect(isWorthSaving(emptyCompose())).toBe(false);
    expect(isWorthSaving({ ...emptyCompose(), title: " x " })).toBe(true);
    expect(isWorthSaving({ ...emptyCompose(), photos: [photo] })).toBe(true);
  });
  it("restores every field after a save (what survives an app kill)", async () => {
    const t = table();
    const f = {
      ...emptyCompose(), title: "Leak", description: "under sink", type: "Defect", assigneeUid: "u1", assigneeName: "Ana",
      deadline: 1_700_000_000_000, buildingId: "b1", photos: [photo],
      location: { storeyName: "L2", bim: null, pdf: { pdfFileId: "f", page: 3, uv: [0.1, 0.2] as [number, number], calibId: "c" } },
    };
    await saveCompose(t, "task-1", "p1", f, 123);
    const back = await loadCompose(t, "task-1", { get: async (k) => (k === "k1" ? new Blob(["x"]) : undefined) });
    expect(back).toMatchObject({ title: "Leak", description: "under sink", type: "Defect", assigneeUid: "u1", deadline: 1_700_000_000_000, buildingId: "b1", location: f.location });
    expect(back?.photos[0]).toMatchObject({ blobKey: "k1", sha256: photo.sha256 });
  });
  it("drops draft photos whose bytes are gone instead of failing the send later", async () => {
    const t = table();
    await saveCompose(t, "task-2", "p1", { ...emptyCompose(), title: "x", photos: [photo] }, 1);
    const back = await loadCompose(t, "task-2", { get: async () => undefined });
    expect(back?.title).toBe("x");
    expect(back?.photos).toEqual([]);
  });
  it("lists summaries newest first, skips corrupt rows, deletes", async () => {
    const t = table();
    await saveCompose(t, "a", "p1", { ...emptyCompose(), title: "old" }, 1);
    await saveCompose(t, "b", "p1", { ...emptyCompose(), title: "new", photos: [photo] }, 2);
    await saveCompose(t, "c", "p2", { ...emptyCompose(), title: "other project" }, 3);
    await t.put({ id: "bad", projectId: "p1", updatedAt: 9, draft: { nope: 1 } });
    const list = await listDraftSummaries(t, "p1");
    expect(list.map((d) => d.id)).toEqual(["b", "a"]);
    expect(list[0].photoCount).toBe(1);
    await deleteDraft(t, "a");
    expect(await loadCompose(t, "a")).toBeUndefined();
    expect(await loadCompose(t, "bad")).toBeUndefined();
  });
});
