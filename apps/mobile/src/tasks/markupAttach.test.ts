import { describe, expect, it, vi } from "vitest";
import type { TaskEntryView } from "@ff/tasks";
import { deriveMarkups, MARKUP_ADDED_TEXT, markupKeyOfPath, markupRemovedText, parseMarkupText, removeMarkup, saveMarkup } from "./markupAttach";

const SHA_A = "a1b2c3d4e5f6" + "0".repeat(52);
const KEY_A = SHA_A.slice(0, 12);
const KEY_B = "b".repeat(12);
const path = (key: string, i = 0) => `projects/p/tasks/t1/${key}-${i}.jpg`;

const entry = (id: string, at: number, text: string, over: Partial<TaskEntryView> = {}): TaskEntryView =>
  ({ id, action: "comment", text, by: "Ana", byUid: "u1", at, statusFrom: 20, statusTo: 20, photos: [], clientGuid: id, pending: false, failed: false, ...over }) as TaskEntryView;

describe("markup tags", () => {
  it("round-trips the two texts", () => {
    expect(parseMarkupText(MARKUP_ADDED_TEXT)).toEqual({ kind: "added" });
    expect(parseMarkupText(markupRemovedText(KEY_A))).toEqual({ kind: "removed", key: KEY_A });
  });
  it("leaves ordinary comments alone", () => {
    for (const t of ["", "Looks fine", "markup added", "see [markup] later", "[markupx] no", "[markup-removed:xyz] bad key", null, undefined]) {
      expect(parseMarkupText(t as string)).toBeNull();
    }
  });
  it("reads the key from the picture path", () => {
    expect(markupKeyOfPath(path(KEY_A))).toBe(KEY_A);
    expect(markupKeyOfPath("projects/p/tasks/t1/location-thumb.jpg")).toBeNull();
    expect(markupKeyOfPath(null)).toBeNull();
  });
});

describe("deriveMarkups", () => {
  const paths = (map: Record<string, string[]>) => (e: TaskEntryView) => map[e.id] ?? [];

  it("lists the live markups oldest first and skips plain comments", () => {
    const entries = [entry("c2", 30, MARKUP_ADDED_TEXT), entry("c0", 5, "hello"), entry("c1", 10, MARKUP_ADDED_TEXT)];
    const d = deriveMarkups(entries, paths({ c1: [path(KEY_A)], c2: [path(KEY_B)] }));
    expect(d.markups.map((m) => m.key)).toEqual([KEY_A, KEY_B]);
    expect(d.markupEntries.has("c0")).toBe(false);
    expect(d.markupEntries.get("c1")).toEqual({ kind: "added", removed: false });
  });
  it("a removal entry hides the markup it names", () => {
    const entries = [entry("c1", 10, MARKUP_ADDED_TEXT), entry("c2", 20, MARKUP_ADDED_TEXT), entry("c3", 30, markupRemovedText(KEY_A))];
    const d = deriveMarkups(entries, paths({ c1: [path(KEY_A)], c2: [path(KEY_B)] }));
    expect(d.markups.map((m) => m.key)).toEqual([KEY_B]);
    expect(d.markupEntries.get("c1")).toEqual({ kind: "added", removed: true });
    expect(d.markupEntries.get("c3")).toEqual({ kind: "removed", removed: true });
  });
  it("carries the pending and failed state of queued entries", () => {
    const entries = [entry("c1", 10, MARKUP_ADDED_TEXT, { pending: true, failed: true })];
    const d = deriveMarkups(entries, paths({ c1: [path(KEY_A)] }));
    expect(d.markups[0]).toMatchObject({ pending: true, failed: true, path: path(KEY_A) });
  });
  it("ignores a tagged entry without a usable picture", () => {
    const d = deriveMarkups([entry("c1", 10, MARKUP_ADDED_TEXT)], paths({}));
    expect(d.markups).toEqual([]);
    expect(d.markupEntries.get("c1")).toEqual({ kind: "added", removed: false });
  });
  it("only comments count (a status action with the same text is not a markup)", () => {
    const d = deriveMarkups([entry("c1", 10, MARKUP_ADDED_TEXT, { action: "reject" })], paths({ c1: [path(KEY_A)] }));
    expect(d.markups).toEqual([]);
  });
});

describe("saveMarkup / removeMarkup", () => {
  const ctx = () => {
    const enqueue = vi.fn().mockResolvedValue(undefined);
    return { enqueue, ctx: { engine: { enqueue }, projectId: "p", taskId: "t1", title: "Crack", statusFrom: 20 as const, actor: { uid: "u1", name: "Ana" } } };
  };
  const deps = (over: Partial<Parameters<typeof saveMarkup>[2]> = {}) => ({
    register: vi.fn(),
    release: vi.fn(),
    sha256: vi.fn().mockResolvedValue(SHA_A),
    newId: () => "xyz",
    ...over,
  });

  it("registers the blob, then queues ONE comment action carrying it", async () => {
    const { enqueue, ctx: c } = ctx();
    const d = deps();
    const pic = new Blob([new Uint8Array(1200)], { type: "image/jpeg" });
    const res = await saveMarkup(c, pic, d);
    expect(res).toEqual({ key: KEY_A, blobKey: "t1-mk-xyz" });
    expect(d.register).toHaveBeenCalledWith("t1-mk-xyz", pic);
    expect(enqueue).toHaveBeenCalledTimes(1);
    const payload = enqueue.mock.calls[0][0];
    expect(payload).toMatchObject({ verb: "comment", taskId: "t1", projectId: "p", text: MARKUP_ADDED_TEXT, statusFrom: 20, statusTo: 20 });
    expect(payload.photoRefs).toEqual([{ blobKey: "t1-mk-xyz", sha256: SHA_A, size: 1200, mime: "image/jpeg" }]);
    expect((d.register as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]).toBeLessThan(enqueue.mock.invocationCallOrder[0]);
  });
  it("drops the blob again when the enqueue fails", async () => {
    const { enqueue, ctx: c } = ctx();
    enqueue.mockRejectedValueOnce(new Error("db closed"));
    const d = deps();
    await expect(saveMarkup(c, new Blob(["x"], { type: "image/jpeg" }), d)).rejects.toThrow("db closed");
    expect(d.release).toHaveBeenCalledWith("t1-mk-xyz");
  });
  it("removing queues a tagged comment without a picture", async () => {
    const { enqueue, ctx: c } = ctx();
    await removeMarkup(c, KEY_A);
    const payload = enqueue.mock.calls[0][0];
    expect(payload).toMatchObject({ verb: "comment", text: markupRemovedText(KEY_A) });
    expect(payload.photoRefs).toEqual([]);
  });
  it("a closed task cannot take a markup (no comment from a terminal status)", async () => {
    const { ctx: c } = ctx();
    await expect(saveMarkup({ ...c, statusFrom: 65 as never }, new Blob(["x"]), deps())).rejects.toThrow(/illegal/);
  });
});
