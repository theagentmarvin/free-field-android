import { describe, expect, it } from "vitest";
import type { OutboxRecord } from "@ff/types";
import { describeVerb, entityKey, friendlyError, groupOutbox, outboxCounts } from "./outboxModel";

function row(over: Partial<OutboxRecord> & { taskId?: string; title?: string; verb?: string }): OutboxRecord {
  const { taskId = "t1", title = "Fix door", verb = "create", ...rest } = over;
  return {
    id: rest.id ?? Math.random().toString(36).slice(2),
    kind: "task-action",
    state: "added",
    projectId: "p",
    payload: { taskId, title, verb },
    photoRefs: [],
    attempts: 0,
    clientGuid: "g",
    createdAt: 1,
    ...rest,
  } as OutboxRecord;
}

describe("outboxCounts", () => {
  it("counts pending (added+sending), failed and sent; ignores killed", () => {
    const c = outboxCounts([
      row({ state: "added" }),
      row({ state: "sending" }),
      row({ state: "failed" }),
      row({ state: "sent" }),
      row({ state: "killed" }),
    ]);
    expect(c).toEqual({ pending: 2, failed: 1, sent: 1 });
  });
});

describe("groupOutbox", () => {
  it("groups by task, orders items oldest first and groups newest first, hides discarded", () => {
    const groups = groupOutbox([
      row({ id: "b2", taskId: "B", title: "Beta", verb: "comment", createdAt: 30 }),
      row({ id: "a1", taskId: "A", title: "Alpha", verb: "create", createdAt: 10 }),
      row({ id: "a2", taskId: "A", verb: "assign", createdAt: 20, state: "sent" }),
      row({ id: "b1", taskId: "B", title: "Beta", verb: "create", createdAt: 5, state: "killed" }),
    ]);
    expect(groups.map((g) => g.title)).toEqual(["Beta", "Alpha"]);
    expect(groups[1].items.map((i) => i.id)).toEqual(["a1", "a2"]);
    expect(groups[0].items.map((i) => i.id)).toEqual(["b2"]);
  });
  it("shows the error only for failed rows and flags retry/discard", () => {
    const [g] = groupOutbox([
      row({ id: "f", state: "failed", lastError: "[permission-denied] nope", attempts: 1 }),
      row({ id: "p", state: "added", lastError: "stale", createdAt: 2 }),
      row({ id: "s", state: "sent", createdAt: 3 }),
    ]);
    const by = Object.fromEntries(g.items.map((i) => [i.id, i]));
    expect(by.f).toMatchObject({ error: "[permission-denied] nope", canRetry: true, canDiscard: true, stateLabel: "Failed" });
    expect(by.p).toMatchObject({ error: null, canRetry: false, canDiscard: true, stateLabel: "Pending" });
    expect(by.s).toMatchObject({ canRetry: false, canDiscard: false, stateLabel: "Sent" });
  });
  it("groups non-task rows by kind", () => {
    const r = { ...row({}), kind: "doc-upsert", payload: {} } as unknown as OutboxRecord;
    expect(entityKey(r)).toBe("kind:doc-upsert");
    expect(groupOutbox([r])[0].title).toBe("Other changes");
  });
  it("returns nothing for an empty outbox", () => {
    expect(groupOutbox([])).toEqual([]);
  });
});

describe("labels", () => {
  it("maps verbs and strips the error code prefix", () => {
    expect(describeVerb(row({ verb: "complete" }))).toBe("Mark complete");
    expect(describeVerb(row({ verb: "weird" }))).toBe("Weird");
    expect(friendlyError("[unavailable] Could not reach Cloud Firestore")).toBe("Could not reach Cloud Firestore");
    expect(friendlyError("plain")).toBe("plain");
  });

  it("explains a rules rejection in plain words instead of the evaluation trace (BUG-11)", () => {
    const text = friendlyError("[permission-denied] evaluation error at L570:26 for 'get' @ L570, false for 'get' @ L570");
    expect(text).toMatch(/permission/i);
    expect(text).not.toMatch(/L570/);
    expect(friendlyError("[unauthenticated] x")).toMatch(/signed out/i);
  });
});
