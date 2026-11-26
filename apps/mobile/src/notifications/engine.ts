import type { Task, TaskEntry } from "@ff/firestore";
import {
  advanceBaseline,
  dedupe,
  deriveEvents,
  notificationId,
  planDeadlines,
  planNotifications,
  seedBaseline,
  tasksNeedingEntries,
  unseenEntries,
  type Baseline,
  type Me,
  type NotifyEvent,
} from "./events";
import type { Notifier } from "./platform";
import type { KV, NotifySettings } from "./settings";

export interface EngineDeps {
  me: Me;
  projectId: string;
  projectName: string;
  kv: KV;
  notifier: Notifier;
  settings(): NotifySettings;
  /** One timeline listener (as TasksSource.watchTaskEntries). */
  watchEntries(taskId: string, cb: (entries: TaskEntry[]) => void): () => void;
  now(): number;
  /** quiet period before a burst is flushed */
  flushMs?: number;
  /** after a fresh seed, snapshots for this long still only seed (a cold cache delivers a partial snapshot, then the server one) */
  settleMs?: number;
  /** how long to wait for the timeline of a changed task to include its newest entry */
  entryWaitMs?: number;
  timers?: { set(cb: () => void, ms: number): unknown; clear(h: unknown): void };
}

const k = (d: EngineDeps, what: string): string => `ffm.notify.${what}.${d.me.uid}.${d.projectId}`;

function readJson<T>(kv: KV, key: string): T | null {
  const raw = kv.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Turns task snapshots of one project into notifications.
 *
 *  - the first snapshot this device ever sees for (user, project) only seeds the baseline: no notifications for the initial download;
 *  - later snapshots are diffed against the persisted baseline, so changes that landed while the app was closed are reported at the next sync;
 *  - timeline entries decide what happened (and who did it); my own entries never notify;
 *  - events are deduped by entry id and flushed after a short quiet period so a burst becomes one grouped summary;
 *  - deadlines are re-planned on every snapshot: due-today/overdue fire once per task per day, and a daily 08:00 local alarm is kept for each open task of mine.
 */
export class NotifyEngine {
  private chain: Promise<void> = Promise.resolve();
  private buffer: NotifyEvent[] = [];
  private flushHandle: unknown = null;
  private disposed = false;
  private flushSeq = 0;
  private seededAt: number | null = null;

  constructor(private readonly d: EngineDeps) {}

  /** Feed one snapshot (the newest window of the project's tasks). Calls are serialized. */
  onTasks(tasks: readonly Task[]): Promise<void> {
    const run = this.chain.then(() => (this.disposed ? undefined : this.process(tasks)));
    this.chain = run.catch(() => undefined);
    return run;
  }

  dispose(): void {
    this.disposed = true;
    if (this.flushHandle != null) this.timers().clear(this.flushHandle);
    this.flushHandle = null;
  }

  /** Raise whatever is buffered now (tests, and app pause). */
  flush(): Promise<void> {
    if (this.flushHandle != null) this.timers().clear(this.flushHandle);
    this.flushHandle = null;
    const events = this.buffer;
    this.buffer = [];
    if (events.length === 0) return Promise.resolve();
    return this.raise(events);
  }

  private timers() {
    return this.d.timers ?? { set: (cb: () => void, ms: number) => setTimeout(cb, ms), clear: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>) };
  }

  private async process(tasks: readonly Task[]): Promise<void> {
    const { kv } = this.d;
    const s = this.d.settings();
    const baseKey = k(this.d, "baseline");
    const base = readJson<Baseline>(kv, baseKey);
    const settling = this.seededAt != null && this.d.now() - this.seededAt < (this.d.settleMs ?? 4000);
    if (!base) {
      kv.set(baseKey, JSON.stringify(seedBaseline(tasks)));
      this.seededAt = this.d.now();
    } else if (!s.master || settling) {
      // Off (or still settling after the first seed): stay current so nothing replays later.
      kv.set(baseKey, JSON.stringify(advanceBaseline(base, tasks)));
    } else {
      await this.diff(base, tasks);
    }
    await this.deadlines(tasks);
  }

  private async diff(base: Baseline, tasks: readonly Task[]): Promise<void> {
    const wanted = tasksNeedingEntries(base, tasks);
    const settled: Task[] = [];
    const events: NotifyEvent[] = [];
    const wantedIds = new Set(wanted.map((t) => t.id));
    // tasks without new entries just refresh their snapshot (status/assignee edits without an entry cannot happen)
    for (const t of tasks) if (!wantedIds.has(t.id)) settled.push(t);
    for (let i = 0; i < wanted.length; i += 5) {
      await Promise.all(
        wanted.slice(i, i + 5).map(async (t) => {
          const entries = await this.fetchEntries(t);
          if (!entries) return; // timeline not here yet: keep the old baseline, retry at the next snapshot
          settled.push(t);
          events.push(...deriveEvents(t, base.tasks[t.id], unseenEntries(t, base.tasks[t.id], entries, base.mark), this.d.me));
        }),
      );
    }
    const seenKey = k(this.d, "seen");
    const { fresh, seen } = dedupe(events, readJson<string[]>(this.d.kv, seenKey) ?? []);
    this.d.kv.set(seenKey, JSON.stringify(seen));
    this.d.kv.set(k(this.d, "baseline"), JSON.stringify(advanceBaseline(base, settled)));
    const s = this.d.settings();
    const keep = fresh.filter((e) => s[e.category]);
    if (keep.length > 0) this.enqueue(keep);
  }

  /** The task's timeline once it contains the newest entry; null when it does not arrive in time. */
  private fetchEntries(task: Task): Promise<TaskEntry[] | null> {
    const wait = this.d.entryWaitMs ?? 6000;
    return new Promise((resolve) => {
      let done = false;
      let unsub: () => void = () => undefined;
      let last: TaskEntry[] | null = null;
      const finish = (v: TaskEntry[] | null) => {
        if (done) return;
        done = true;
        this.timers().clear(timer);
        queueMicrotask(() => unsub());
        resolve(v);
      };
      const timer = this.timers().set(() => finish(last && last.length >= task.entryCount ? last : null), wait);
      try {
        unsub = this.d.watchEntries(task.id, (entries) => {
          last = entries;
          if (entries.length >= task.entryCount) finish(entries);
        });
      } catch {
        finish(null);
      }
      if (done) unsub();
    });
  }

  private enqueue(events: NotifyEvent[]): void {
    this.buffer.push(...events);
    if (this.flushHandle != null) this.timers().clear(this.flushHandle);
    this.flushHandle = this.timers().set(() => {
      this.flushHandle = null;
      void this.flush().catch((err) => console.warn("[notify] could not show notifications", err));
    }, this.d.flushMs ?? 1200);
  }

  private async raise(events: NotifyEvent[]): Promise<void> {
    if (this.disposed) return;
    // First useful moment: ask for the OS permission now (never at launch). Refused: nothing is shown.
    if (!(await this.d.notifier.ensurePermission())) return;
    const plans = planNotifications(events, this.d.projectId, this.d.projectName, this.d.now() + this.flushSeq++);
    await this.d.notifier.show(plans);
  }

  private async deadlines(tasks: readonly Task[]): Promise<void> {
    const s = this.d.settings();
    const idsKey = k(this.d, "alarms");
    const had = readJson<number[]>(this.d.kv, idsKey) ?? [];
    const enabled = s.master && s.deadlines;
    const ledgerKey = k(this.d, "deadline-ledger");
    const plan = enabled ? planDeadlines(tasks, this.d.me, this.d.now(), readJson<Record<string, string>>(this.d.kv, ledgerKey) ?? {}) : null;
    const want = (plan?.schedule ?? []).map((x) => ({
      id: notificationId(`deadline:${this.d.projectId}:${x.taskId}`),
      title: `Deadline reminder: ${x.num}`,
      body: `${x.title} · due ${x.dueLabel}`,
      at: x.at,
      path: `/tasks/${encodeURIComponent(x.taskId)}`,
      projectId: this.d.projectId,
      group: `project:${this.d.projectId}`,
    }));
    // This snapshot is only a window of the project: keep alarms of tasks that are not in it.
    const inWindow = new Set(tasks.map((t) => notificationId(`deadline:${this.d.projectId}:${t.id}`)));
    const wantIds = new Set(want.map((w) => w.id));
    const stale = had.filter((id) => !wantIds.has(id) && (inWindow.has(id) || !enabled));
    if (stale.length > 0) await this.d.notifier.cancel(stale);
    if (!enabled || !plan) {
      this.d.kv.set(idsKey, JSON.stringify(had.filter((id) => !stale.includes(id))));
      return;
    }
    const kept = had.filter((id) => !stale.includes(id));
    this.d.kv.set(idsKey, JSON.stringify([...new Set([...kept, ...wantIds])]));
    this.d.kv.set(ledgerKey, JSON.stringify({ ...(readJson<Record<string, string>>(this.d.kv, ledgerKey) ?? {}), ...plan.ledger }));
    const reminders = plan.now;
    // Prompt for the OS permission only when something is due right now (a useful moment); silently
    // keep the daily alarms only once it has been granted (a settings toggle re-runs this).
    const ok = reminders.length > 0 ? await this.d.notifier.ensurePermission() : (await this.d.notifier.permission()) === "granted";
    if (!ok) return;
    if (want.length > 0) await this.d.notifier.scheduleDaily(want);
    if (reminders.length > 0) await this.d.notifier.show(planNotifications(reminders, this.d.projectId, this.d.projectName, this.d.now()));
  }
}
