// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { emptyExtras, extrasEdit, forgetExtras, hasExtras, loadExtras, parseExtras, saveExtras } from "./createExtras";

const actor = { uid: "u1", name: "Ana" };
const created = { taskId: "t1", projectId: "p1", title: "Crack", statusTo: 10, actor, at: 1000 };

describe("create extras", () => {
  beforeEach(() => localStorage.clear());

  it("an untouched form has no extras and produces no edit", () => {
    expect(hasExtras(emptyExtras())).toBe(false);
    expect(extrasEdit(emptyExtras(), created)).toBeNull();
  });

  it("round-trips per draft id and forgets", () => {
    const e = { priority: "high" as const, checklist: [{ id: "c1", text: "Photo", done: false }], watchers: ["u2"] };
    saveExtras("t1", e);
    expect(loadExtras("t1")).toEqual(e);
    expect(loadExtras("other")).toEqual(emptyExtras());
    forgetExtras("t1");
    expect(loadExtras("t1")).toEqual(emptyExtras());
  });

  it("drops junk from storage", () => {
    expect(parseExtras({ priority: "nope", checklist: 5, watchers: "x" })).toEqual(emptyExtras());
  });

  it("keeps the status the create (or the assign after it) left: the edit never moves the task", () => {
    const p = extrasEdit({ priority: "high", checklist: [], watchers: [] }, { ...created, statusTo: 20 });
    expect((p as unknown as { statusFrom: number; statusTo: number }).statusFrom).toBe(20);
    expect((p as unknown as { statusTo: number }).statusTo).toBe(20);
  });

  it("builds one edit carrying the chosen fields", () => {
    const p = extrasEdit({ priority: "critical", checklist: [{ id: "c1", text: "Photo", done: false }], watchers: ["u2"] }, created);
    expect(p).not.toBeNull();
    expect(p!.taskId).toBe("t1");
    const patch = (p as unknown as { patch: Record<string, unknown> }).patch;
    expect(patch.priority).toBe("critical");
    expect(patch.watchers).toEqual(["u2"]);
    expect(patch.checklist).toHaveLength(1);
  });
});
