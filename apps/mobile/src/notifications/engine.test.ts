import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskEntry } from "@ff/firestore";
import { NotifyEngine } from "./engine";
import type { NotificationPlan } from "./events";
import { entry, ME, task } from "./fixtures";
import type { Notifier } from "./platform";
import { DEFAULT_SETTINGS, type KV, type NotifySettings } from "./settings";

function memoryKV(): KV {
  const m = new Map<string, string>();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v), remove: (k) => void m.delete(k) };
}

interface Harness {
  engine: NotifyEngine;
  shown: NotificationPlan[][];
  scheduled: Array<{ id: number; at: number }>;
  cancelled: number[][];
  timelines: Map<string, TaskEntry[]>;
  settings: NotifySettings;
  perm: { value: "granted" | "denied" | "prompt"; asked: number };
}

function harness(kv: KV = memoryKV(), now = () => new Date(2026, 10, 26, 12, 0).getTime()): Harness {
  const h = {
    shown: [] as NotificationPlan[][],
    scheduled: [] as Array<{ id: number; at: number }>,
    cancelled: [] as number[][],
    timelines: new Map<string, TaskEntry[]>(),
    settings: { ...DEFAULT_SETTINGS },
    perm: { value: "prompt" as "granted" | "denied" | "prompt", asked: 0 },
  } as Harness;
  const notifier: Notifier = {
    permission: async () => h.perm.value,
    ensurePermission: async () => {
      if (h.perm.value === "prompt") {
        h.perm.asked += 1;
        h.perm.value = "granted";
      }
      return h.perm.value === "granted";
    },
    show: async (p) => void h.shown.push([...p]),
    scheduleDaily: async (items) => void h.scheduled.push(...items.map((i) => ({ id: i.id, at: i.at }))),
    cancel: async (ids) => void h.cancelled.push([...ids]),
  };
  h.engine = new NotifyEngine({
    me: ME,
    projectId: "p1",
    projectName: "Tower A",
    kv,
    notifier,
    settings: () => h.settings,
    watchEntries: (id, cb) => {
      queueMicrotask(() => cb(h.timelines.get(id) ?? []));
      return () => undefined;
    },
    now,
    flushMs: 10,
    settleMs: 0,
    entryWaitMs: 50,
  });
  return h;
}

const settle = () => new Promise((r) => setTimeout(r, 30));

describe("NotifyEngine", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("seeds silently on the first snapshot (initial bulk download)", async () => {
    const many = Array.from({ length: 30 }, (_, i) => task({ id: `t${i}`, num: i + 1, assigneeUid: "me", status: 20, updatedAt: 100 + i }));
    for (const t of many) h.timelines.set(t.id, [entry(`c-${t.id}`, { action: "create", at: 100 })]);
    await h.engine.onTasks(many);
    await settle();
    expect(h.shown).toEqual([]);
    expect(h.perm.asked).toBe(0);
  });

  it("a partial first snapshot followed by the full one is still the initial download", async () => {
    let clock = 1000;
    const kv = memoryKV();
    const a = harness(kv, () => clock);
    // rebuild with a settle window
    const eng = new NotifyEngine({ me: ME, projectId: "p1", projectName: "Tower A", kv: memoryKV(), notifier: { permission: async () => "granted", ensurePermission: async () => true, show: async (p) => void a.shown.push([...p]), scheduleDaily: async () => undefined, cancel: async () => undefined }, settings: () => a.settings, watchEntries: (id, cb) => { queueMicrotask(() => cb(a.timelines.get(id) ?? [])); return () => undefined; }, now: () => clock, flushMs: 10, settleMs: 4000 });
    await eng.onTasks([]);
    clock += 500;
    const t = task({ id: "n", assigneeUid: "me", status: 20, updatedAt: 5000 });
    a.timelines.set("n", [entry("c", { action: "create", at: 5000 })]);
    await eng.onTasks([t]);
    await settle();
    expect(a.shown).toEqual([]);
    clock += 10_000;
    const t2 = task({ id: "m", assigneeUid: "me", status: 20, updatedAt: 20_000 });
    a.timelines.set("m", [entry("c2", { action: "create", at: 20_000 })]);
    await eng.onTasks([t, t2]);
    await settle();
    expect(a.shown).toHaveLength(1);
  });

  it("raises a notification for another user's new assignment, and asks for permission at that moment", async () => {
    await h.engine.onTasks([task({ id: "old", updatedAt: 100 })]);
    const t = task({ id: "new", num: 20, assigneeUid: "me", status: 20, updatedAt: 500, title: "Check anchor bolts" });
    h.timelines.set("new", [entry("c1", { action: "create", at: 500, statusTo: 20 })]);
    await h.engine.onTasks([t, task({ id: "old", updatedAt: 100 })]);
    await settle();
    expect(h.perm.asked).toBe(1);
    expect(h.shown).toHaveLength(1);
    expect(h.shown[0]![0]).toMatchObject({ title: "T020 assigned to you", path: "/tasks/new" });
  });

  it("does not notify twice for the same snapshot or after a restart", async () => {
    const kv = memoryKV();
    const a = harness(kv);
    await a.engine.onTasks([task({ id: "x", updatedAt: 100 })]);
    const grown = task({ id: "x", assigneeUid: "me", entryCount: 2, updatedAt: 200 });
    a.timelines.set("x", [entry("e0", { action: "create", at: 100 }), entry("e1", { action: "comment", at: 200, text: "ping" })]);
    await a.engine.onTasks([grown]);
    await a.engine.onTasks([grown]);
    await settle();
    expect(a.shown).toHaveLength(1);
    // app restarted: same data, same kv
    const b = harness(kv);
    b.timelines = a.timelines;
    await b.engine.onTasks([grown]);
    await settle();
    expect(b.shown).toEqual([]);
  });

  it("reports changes that landed while the app was closed", async () => {
    const kv = memoryKV();
    const first = harness(kv);
    await first.engine.onTasks([task({ id: "x", createdByUid: "me", status: 20, updatedAt: 100 })]);
    const second = harness(kv);
    second.timelines.set("x", [entry("e0", { action: "create", at: 100 }), entry("e1", { action: "approve", at: 300, statusFrom: 40, statusTo: 65 })]);
    await second.engine.onTasks([task({ id: "x", createdByUid: "me", status: 65, entryCount: 2, updatedAt: 300 })]);
    await settle();
    expect(second.shown[0]![0]!.title).toBe("T012 moved to Approved");
  });

  it("never notifies for my own edits", async () => {
    await h.engine.onTasks([task({ id: "x", createdByUid: "me", status: 20, updatedAt: 100 })]);
    h.timelines.set("x", [entry("e0", { action: "create", byUid: "me", at: 100 }), entry("e1", { action: "complete", byUid: "me", at: 200, statusFrom: 20, statusTo: 40 })]);
    await h.engine.onTasks([task({ id: "x", createdByUid: "me", status: 40, entryCount: 2, updatedAt: 200 })]);
    await settle();
    expect(h.shown).toEqual([]);
  });

  it("batches a burst into one grouped summary", async () => {
    const base = Array.from({ length: 5 }, (_, i) => task({ id: `t${i}`, num: i + 1, createdByUid: "me", status: 20, updatedAt: 100 }));
    await h.engine.onTasks(base);
    const changed: Task[] = base.map((t, i) => ({ ...t, status: 40, entryCount: 2, updatedAt: 300 + i }));
    for (const t of base) h.timelines.set(t.id, [entry(`c${t.id}`, { action: "create", at: 100 }), entry(`s${t.id}`, { action: "complete", at: 300, statusFrom: 20, statusTo: 40 })]);
    await h.engine.onTasks(changed);
    await settle();
    expect(h.shown).toHaveLength(1);
    expect(h.shown[0]).toHaveLength(1);
    expect(h.shown[0]![0]).toMatchObject({ title: "5 task updates in Tower A", path: "/tasks" });
  });

  it("respects the master switch and per-category switches, without replaying history later", async () => {
    await h.engine.onTasks([task({ id: "x", assigneeUid: "me", status: 20, updatedAt: 100 })]);
    h.timelines.set("x", [entry("e0", { action: "create", at: 100 }), entry("e1", { text: "one", at: 200 })]);
    h.settings = { ...DEFAULT_SETTINGS, comments: false };
    await h.engine.onTasks([task({ id: "x", assigneeUid: "me", status: 20, entryCount: 2, updatedAt: 200 })]);
    await settle();
    expect(h.shown).toEqual([]);

    h.settings = { ...DEFAULT_SETTINGS, master: false };
    h.timelines.set("x", [...h.timelines.get("x")!, entry("e2", { text: "two", at: 300 })]);
    await h.engine.onTasks([task({ id: "x", assigneeUid: "me", status: 20, entryCount: 3, updatedAt: 300 })]);
    h.settings = { ...DEFAULT_SETTINGS };
    h.timelines.set("x", [...h.timelines.get("x")!, entry("e3", { text: "three", at: 400 })]);
    await h.engine.onTasks([task({ id: "x", assigneeUid: "me", status: 20, entryCount: 4, updatedAt: 400 })]);
    await settle();
    expect(h.shown).toHaveLength(1);
    expect(h.shown[0]![0]!.body).toBe("three");
  });

  it("does not show anything when the OS permission is refused", async () => {
    h.perm.value = "denied";
    await h.engine.onTasks([task({ id: "x", assigneeUid: "me", status: 20, updatedAt: 100 })]);
    h.timelines.set("x", [entry("e0", { action: "create", at: 100 }), entry("e1", { text: "hi", at: 200 })]);
    await h.engine.onTasks([task({ id: "x", assigneeUid: "me", status: 20, entryCount: 2, updatedAt: 200 })]);
    await settle();
    expect(h.shown).toEqual([]);
  });

  it("keeps the old baseline when the timeline has not arrived, and retries", async () => {
    await h.engine.onTasks([task({ id: "x", assigneeUid: "me", status: 20, updatedAt: 100 })]);
    const grown = task({ id: "x", assigneeUid: "me", status: 20, entryCount: 2, updatedAt: 200 });
    h.timelines.set("x", [entry("e0", { action: "create", at: 100 })]); // newest entry missing
    await h.engine.onTasks([grown]);
    await settle();
    expect(h.shown).toEqual([]);
    h.timelines.set("x", [entry("e0", { action: "create", at: 100 }), entry("e1", { text: "late", at: 200 })]);
    await h.engine.onTasks([grown]);
    await settle();
    expect(h.shown).toHaveLength(1);
  });

  describe("deadlines", () => {
    const noon = new Date(2026, 10, 26, 12, 0).getTime();
    it("fires due-today once per day and keeps a daily alarm", async () => {
      h.perm.value = "granted";
      const due = task({ id: "d", assigneeUid: "me", status: 20, deadline: noon + 3_600_000, updatedAt: 100 });
      await h.engine.onTasks([due]);
      await h.engine.onTasks([due]);
      await settle();
      expect(h.shown).toHaveLength(1);
      expect(h.shown[0]![0]!.title).toBe("T012 is due today");
      expect(h.scheduled.length).toBeGreaterThan(0);
      expect(new Date(h.scheduled[0]!.at).getHours()).toBe(8);
    });

    it("cancels the alarm when the task closes, and does not prompt for permission just to schedule", async () => {
      const future = task({ id: "d", assigneeUid: "me", status: 20, deadline: noon + 3 * 86_400_000, updatedAt: 100 });
      await h.engine.onTasks([future]);
      expect(h.perm.asked).toBe(0);
      expect(h.scheduled).toEqual([]); // not granted yet
      h.perm.value = "granted";
      await h.engine.onTasks([future]);
      expect(h.scheduled).toHaveLength(1);
      await h.engine.onTasks([{ ...future, status: 65, entryCount: 2, updatedAt: 200 }]);
      expect(h.cancelled.flat()).toContain(h.scheduled[0]!.id);
    });

    it("cancels everything when deadlines are switched off", async () => {
      h.perm.value = "granted";
      const future = task({ id: "d", assigneeUid: "me", status: 20, deadline: noon + 3 * 86_400_000, updatedAt: 100 });
      await h.engine.onTasks([future]);
      h.settings = { ...DEFAULT_SETTINGS, deadlines: false };
      await h.engine.onTasks([future]);
      expect(h.cancelled.flat()).toContain(h.scheduled[0]!.id);
    });
  });
});

vi.setConfig({ testTimeout: 5000 });
