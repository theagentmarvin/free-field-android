import { describe, expect, it } from "vitest";
import { buildTaskEdit } from "./edits";
import { canAssign, canComment, canEdit, statusActionsFor } from "./transitions";
import type { TaskView } from "@ff/tasks";

const v = (s: number) => statusActionsFor(s).map((a) => a.verb);
describe("status transitions", () => {
  it("offers only legal verbs per status", () => {
    expect(v(10)).toEqual(["discontinue"]);
    expect(v(20)).toEqual(["complete", "discontinue"]);
    expect(v(40)).toEqual(["approve", "followup", "reject", "discontinue"]);
    expect(v(60)).toEqual(["complete", "discontinue"]);
    expect(v(65)).toEqual([]);
    expect(v(80)).toEqual([]);
    expect(statusActionsFor(null)).toEqual([]);
  });
  it("comment/edit/assign gating", () => {
    expect(canComment(20)).toBe(true);
    expect(canComment(65)).toBe(false);
    expect(canEdit(80)).toBe(false);
    expect(canAssign(40)).toBe(false);
    expect(canAssign(10)).toBe(true);
  });
});

const task: TaskView = { id: "t1", num: 1, title: "A", status: 10, updatedAt: 1, assigneeName: null, lastAction: "create", entryCount: 1 };
const ctx = { projectId: "p", actor: { uid: "u", name: "U" }, at: 5, guid: "g" };
describe("buildTaskEdit", () => {
  it("no-op edit yields nothing", () => {
    expect(buildTaskEdit(task, { title: "A" }, ctx)).toBeNull();
  });
  it("assign-only from inbox uses assign; never writes extended fields", () => {
    const p = buildTaskEdit(task, { assigneeUid: "x", assigneeName: "X" }, ctx)!;
    expect(p.verb).toBe("assign");
    expect(p.statusTo).toBe(20);
    expect(Object.keys(p.patch!).sort()).toEqual(["assigneeName", "assigneeUid"]);
  });
  it("assignee change while awaiting approval is an edit", () => {
    const p = buildTaskEdit({ ...task, status: 40 }, { assigneeUid: "x", assigneeName: "X" }, ctx)!;
    expect(p.verb).toBe("edit");
    expect(p.statusTo).toBe(40);
  });
  it("terminal tasks are read-only", () => {
    expect(buildTaskEdit({ ...task, status: 65 }, { title: "B" }, ctx)).toBeNull();
  });
  it("title edit keeps location pins", () => {
    const loc = { storeyName: "L1", bim: null, pdf: { pdfFileId: "f", page: 1, uv: [0, 0] as [number, number], calibId: "c" } };
    const p = buildTaskEdit({ ...task, location: loc }, { storeyName: "L2" }, ctx)!;
    expect((p.patch!.location as typeof loc).pdf).toEqual(loc.pdf);
    expect((p.patch!.location as typeof loc).storeyName).toBe("L2");
  });
});
