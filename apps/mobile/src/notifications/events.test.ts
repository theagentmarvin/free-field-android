import { describe, expect, it } from "vitest";
import {
  dayKey,
  dedupe,
  deriveEvents,
  notificationId,
  planDeadlines,
  planNotifications,
  seedBaseline,
  SEEN_CAP,
  snapOf,
  tasksNeedingEntries,
  unseenEntries,
  type NotifyEvent,
} from "./events";
import { entry, ME, task } from "./fixtures";

describe("tasksNeedingEntries / unseenEntries", () => {
  it("only reads timelines of tasks that grew or are new", () => {
    const a = task({ id: "a", entryCount: 2, updatedAt: 10 });
    const b = task({ id: "b", entryCount: 1, updatedAt: 10 });
    const base = seedBaseline([a, b]);
    const grown = { ...a, entryCount: 3, updatedAt: 20 };
    const fresh = task({ id: "c", updatedAt: 30 });
    const old = task({ id: "d", updatedAt: 5 }); // older than the mark: just newly in view
    expect(tasksNeedingEntries(base, [grown, b, fresh, old]).map((t) => t.id)).toEqual(["a", "c"]);
  });

  it("returns the last N entries for a known task and the ones past the mark for an unknown one", () => {
    const t = task({ entryCount: 3 });
    const es = [entry("e1", { at: 1 }), entry("e2", { at: 2 }), entry("e3", { at: 3 })];
    expect(unseenEntries(t, { n: 2, s: 10, a: null }, es, 0).map((e) => e.id)).toEqual(["e3"]);
    expect(unseenEntries(t, undefined, es, 1).map((e) => e.id)).toEqual(["e2", "e3"]);
  });
});

describe("deriveEvents", () => {
  it("a new task assigned to me notifies", () => {
    const t = task({ assigneeUid: "me", status: 20 });
    const ev = deriveEvents(t, undefined, [entry("c", { action: "create", statusFrom: null, statusTo: 20 })], ME);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ kind: "assigned", headline: "T012 assigned to you", id: "t1:c" });
  });

  it("an assign action notifies only when I was not already the assignee", () => {
    const t = task({ assigneeUid: "me", status: 20 });
    const assign = entry("a1", { action: "assign", statusFrom: 20, statusTo: 20 });
    expect(deriveEvents(t, { n: 1, s: 20, a: null }, [assign], ME)[0]?.kind).toBe("assigned");
    expect(deriveEvents(t, { n: 1, s: 20, a: "me" }, [assign], ME)).toEqual([]);
  });

  it("never notifies for my own entries", () => {
    const t = task({ assigneeUid: "me", createdByUid: "me", status: 40 });
    const mine = [
      entry("a", { action: "assign", byUid: "me", by: ME.name }),
      entry("b", { action: "complete", byUid: "me", statusFrom: 20, statusTo: 40 }),
      entry("c", { action: "comment", byUid: "me", text: "@Alex Rivera hi" }),
    ];
    expect(deriveEvents(t, undefined, mine, ME)).toEqual([]);
  });

  it("status change matters only on tasks I created or am assigned", () => {
    const e = entry("s", { action: "complete", statusFrom: 20, statusTo: 40 });
    expect(deriveEvents(task({ createdByUid: "me" }), { n: 1, s: 20, a: null }, [e], ME)[0]).toMatchObject({ kind: "status", headline: "T012 moved to Awaiting approval" });
    expect(deriveEvents(task({ assigneeUid: "me" }), { n: 1, s: 20, a: "me" }, [e], ME)).toHaveLength(1);
    expect(deriveEvents(task(), { n: 1, s: 20, a: null }, [e], ME)).toEqual([]);
  });

  it("an @mention reaches me even on a task I am not involved in, a plain comment only when involved", () => {
    const mention = entry("m", { text: "@Alex Rivera can you check the rebar?" });
    expect(deriveEvents(task(), undefined, [mention], ME)[0]).toMatchObject({ kind: "mention", category: "comments", body: "@Alex Rivera can you check the rebar?" });
    const plain = entry("p", { text: "photo attached" });
    expect(deriveEvents(task(), undefined, [plain], ME)).toEqual([]);
    expect(deriveEvents(task({ assigneeUid: "me" }), undefined, [plain], ME)[0]?.kind).toBe("comment");
  });

  it("a mention of someone else is not a mention of me", () => {
    expect(deriveEvents(task(), undefined, [entry("x", { text: "@Mateo Rojas please" })], ME)).toEqual([]);
  });

  it("one event per entry: the assignment wins over the status change it also carries", () => {
    const t = task({ assigneeUid: "me", status: 20 });
    const ev = deriveEvents(t, { n: 1, s: 10, a: null }, [entry("a", { action: "assign", statusFrom: 10, statusTo: 20 })], ME);
    expect(ev.map((e) => e.kind)).toEqual(["assigned"]);
  });

  it("clips long comment bodies", () => {
    const ev = deriveEvents(task({ assigneeUid: "me" }), undefined, [entry("l", { text: "x".repeat(400) })], ME);
    expect(ev[0]!.body.length).toBeLessThanOrEqual(140);
  });
});

describe("dedupe", () => {
  const ev = (id: string): NotifyEvent => ({ id, kind: "comment", category: "comments", taskId: "t", num: "T001", title: "t", line: "l", headline: "h", body: "b", at: 1 });
  it("drops events seen before, also inside one batch", () => {
    const r = dedupe([ev("a"), ev("b"), ev("a")], ["b"]);
    expect(r.fresh.map((e) => e.id)).toEqual(["a"]);
    expect(r.seen).toEqual(["b", "a"]);
  });
  it("caps the ledger, keeping the newest", () => {
    const old = Array.from({ length: SEEN_CAP }, (_, i) => `o${i}`);
    const r = dedupe([ev("n")], old);
    expect(r.seen).toHaveLength(SEEN_CAP);
    expect(r.seen.at(-1)).toBe("n");
    expect(r.seen[0]).toBe("o1");
  });
});

describe("planDeadlines", () => {
  const noon = new Date(2026, 10, 26, 12, 0).getTime();
  const day = (offset: number, h = 17) => new Date(2026, 10, 26 + offset, h, 0).getTime();
  const mine = (over: object) => task({ assigneeUid: "me", status: 20, ...over });

  it("reminds due-today and overdue open tasks of mine once per day", () => {
    const tasks = [mine({ id: "today", deadline: day(0) }), mine({ id: "late", deadline: day(-3) }), mine({ id: "later", deadline: day(2) })];
    const first = planDeadlines(tasks, ME, noon, {});
    expect(first.now.map((e) => [e.taskId, e.kind])).toEqual([["today", "deadline-today"], ["late", "deadline-overdue"]]);
    const again = planDeadlines(tasks, ME, noon + 3_600_000, first.ledger);
    expect(again.now).toEqual([]);
    const nextDay = planDeadlines(tasks, ME, day(1, 9), first.ledger);
    expect(nextDay.now.map((e) => e.taskId).sort()).toEqual(["late", "today"]);
    expect(first.ledger).toEqual({ today: dayKey(noon), late: dayKey(noon) });
  });

  it("ignores closed tasks, other people's tasks and tasks without a deadline", () => {
    const tasks = [
      mine({ id: "done", status: 65, deadline: day(0) }),
      task({ id: "theirs", assigneeUid: "ana", deadline: day(0) }),
      mine({ id: "none", deadline: null }),
    ];
    const p = planDeadlines(tasks, ME, noon, {});
    expect(p.now).toEqual([]);
    expect(p.schedule).toEqual([]);
  });

  it("includes my unassigned tasks and schedules a daily 08:00 alarm", () => {
    const p = planDeadlines([task({ id: "own", createdByUid: "me", status: 10, deadline: day(2) }), mine({ id: "late", deadline: day(-1) })], ME, noon, {});
    const own = p.schedule.find((s) => s.taskId === "own")!;
    expect(new Date(own.at).getHours()).toBe(8);
    expect(dayKey(own.at)).toBe(dayKey(day(2)));
    // already due: the first alarm is tomorrow, today's reminder fires now
    const late = p.schedule.find((s) => s.taskId === "late")!;
    expect(dayKey(late.at)).toBe(dayKey(day(1)));
    expect(p.now.map((e) => e.taskId)).toEqual(["late"]);
  });

  it("prunes the ledger to current candidates", () => {
    const p = planDeadlines([mine({ id: "a", deadline: day(0) })], ME, noon, { gone: "2026-01-01" });
    expect(Object.keys(p.ledger)).toEqual(["a"]);
  });
});

describe("planNotifications", () => {
  const ev = (i: number): NotifyEvent => ({ id: `t${i}:e`, kind: "status", category: "status", taskId: `t${i}`, num: `T00${i}`, title: "t", line: `T00${i} moved to Ongoing`, headline: `T00${i} moved to Ongoing`, body: "b", at: i });
  it("single events open their task", () => {
    const [p] = planNotifications([ev(1)], "p1", "Tower A", 0);
    expect(p).toMatchObject({ path: "/tasks/t1", title: "T001 moved to Ongoing", channel: "tasks" });
  });
  it("a burst becomes one grouped summary that opens the list", () => {
    const plans = planNotifications([ev(1), ev(2), ev(3), ev(4), ev(5)], "p1", "Tower A", 7);
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ title: "5 task updates in Tower A", path: "/tasks", summary: true });
    expect(plans[0]!.lines).toHaveLength(5);
    expect(plans[0]!.body).toContain("+2 more");
  });
  it("collapses identical summary lines into a count", () => {
    const same = (i: number): NotifyEvent => ({ ...ev(1), id: `t1:e${i}`, line: "Ana Silva commented on T001" });
    const [p] = planNotifications([same(1), same(2), same(3), ev(2)], "p1", "Tower A", 0);
    expect(p!.title).toBe("4 task updates in Tower A");
    expect(p!.lines).toEqual(["Ana Silva commented on T001 (x3)", "T002 moved to Ongoing"]);
  });
  it("ids are stable, positive 31-bit ints", () => {
    expect(notificationId("x")).toBe(notificationId("x"));
    expect(notificationId("x")).not.toBe(notificationId("y"));
    expect(notificationId("some long key")).toBeGreaterThanOrEqual(0);
    expect(notificationId("some long key")).toBeLessThanOrEqual(0x7fffffff);
  });
});

describe("snapOf", () => {
  it("keeps only what the diff needs", () => {
    expect(snapOf(task({ entryCount: 4, status: 20, assigneeUid: "me" }))).toEqual({ n: 4, s: 20, a: "me" });
  });
});
