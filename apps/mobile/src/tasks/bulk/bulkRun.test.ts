import { describe, expect, it } from "vitest";
import { planBulk, type BulkRowInput } from "@ff/tasks-react";
import type { TaskActionPayload } from "@ff/tasks";
import { runBulkPlan, runUndo, summarizeBulk, SKIP_TEXT } from "./bulkRun";

const row = (id: string, status: number, over: Partial<BulkRowInput> = {}): BulkRowInput => ({ id, title: `Task ${id}`, status, assigneeUid: null, assigneeName: null, deadline: null, type: "task", priority: "normal", ...over });

function ctx() {
  const sent: TaskActionPayload[] = [];
  return { sent, ctx: { projectId: "p1", actor: { uid: "u1", name: "Ana" }, enqueue: async (p: TaskActionPayload) => void sent.push(p) } };
}

describe("bulk summary mapping", () => {
  it("12 updated, 2 skipped: not allowed in this status", () => {
    expect(summarizeBulk({ updated: 12, failed: 0, skipped: [{ reason: "illegal", count: 2 }] })).toBe("12 updated, 2 skipped: not allowed in this status");
  });
  it("several skip reasons are itemised; failures are appended; no skips reads plainly", () => {
    expect(summarizeBulk({ updated: 3, failed: 1, skipped: [{ reason: "closed", count: 2 }, { reason: "unchanged", count: 1 }] })).toBe("3 updated, 3 skipped: 2 task is closed, 1 already set, 1 failed");
    expect(summarizeBulk({ updated: 5, failed: 0, skipped: [] })).toBe("5 updated");
    expect(SKIP_TEXT.pending).toBe("still syncing");
  });
});

describe("running a plan through the outbox", () => {
  it("a status change over a mixed selection queues the legal rows and reports the rest as skipped", async () => {
    // ongoing (20) can be submitted; awaiting approval (40) and approved (65) cannot
    const rows = [row("a", 20), row("b", 20), row("c", 40), row("d", 65), row("e", 20, { pending: true })];
    const plan = planBulk(rows, { kind: "status", verb: "complete" });
    const { sent, ctx: c } = ctx();
    const out = await runBulkPlan("Status", plan, c);
    expect(sent.map((p) => [p.taskId, p.verb])).toEqual([["a", "complete"], ["b", "complete"]]);
    expect(sent.every((p) => p.projectId === "p1" && p.statusFrom === 20)).toBe(true);
    expect(out.updated).toBe(2);
    expect(summarizeBulk(out)).toBe("2 updated, 3 skipped: 1 not allowed in this status, 1 task is closed, 1 still syncing");
    expect(out.undo.length).toBe(2);
  });

  it("assignee, deadline and priority go through the same edit/assign actions as a single edit, with the patch", async () => {
    const rows = [row("a", 20), row("b", 20, { assigneeUid: "u9", assigneeName: "Zed" }), row("c", 65)];
    const { sent, ctx: c } = ctx();
    const out = await runBulkPlan("Assignee", planBulk(rows, { kind: "assignee", uid: "u9", name: "Zed" }), c);
    expect(sent.length).toBe(1);
    expect(sent[0]!.taskId).toBe("a");
    expect(JSON.stringify(sent[0]!.patch)).toContain("Zed");
    expect(out.skipped.map((s) => s.reason).sort()).toEqual(["closed", "unchanged"]);
    const dl = await runBulkPlan("Deadline", planBulk([row("a", 20)], { kind: "deadline", deadline: 1_800_000_000_000 }), ctx().ctx);
    expect(dl.updated).toBe(1);
    const pr = await runBulkPlan("Priority", planBulk([row("a", 20)], { kind: "priority", priority: "critical" }), ctx().ctx);
    expect(pr.updated).toBe(1);
  });

  it("an enqueue that fails counts as failed and does not stop the rest; Undo re-queues the reverse actions", async () => {
    const rows = [row("a", 20), row("b", 20), row("c", 20)];
    const plan = planBulk(rows, { kind: "assignee", uid: "u9", name: "Zed" });
    const sent: TaskActionPayload[] = [];
    const c = { projectId: "p1", actor: { uid: "u1", name: "Ana" }, enqueue: async (p: TaskActionPayload) => { if (p.taskId === "b") throw new Error("illegal"); sent.push(p); } };
    const out = await runBulkPlan("Assignee", plan, c);
    expect([out.updated, out.failed]).toEqual([2, 1]);
    expect(summarizeBulk(out)).toBe("2 updated, 1 failed");
    const undone = ctx();
    const r = await runUndo(out.undo, undone.ctx);
    expect(r).toEqual({ reverted: 2, failed: 0 });
    expect(undone.sent.map((p) => p.taskId)).toEqual(["a", "c"]);
  });
});
