import { Capacitor } from "@capacitor/core";
import { LocalNotifications } from "@capacitor/local-notifications";
import type { NotificationPlan } from "./events";

/** The OS side of notifications, behind an interface so the engine is testable without Capacitor. */
export interface Notifier {
  /** Current permission without prompting. */
  permission(): Promise<"granted" | "denied" | "prompt">;
  /** Granted already, or ask now (the Android 13+ runtime dialog). Resolves false when refused or unavailable. */
  ensurePermission(): Promise<boolean>;
  show(plans: readonly NotificationPlan[]): Promise<void>;
  /** Daily local reminders (survive app restarts and reboots; the plugin restores them on boot). */
  scheduleDaily(items: ReadonlyArray<{ id: number; title: string; body: string; at: number; path: string; projectId: string; group: string }>): Promise<void>;
  cancel(ids: readonly number[]): Promise<void>;
}

const native = (): boolean => Capacitor.isNativePlatform();

let channelsReady: Promise<void> | null = null;
function ensureChannels(): Promise<void> {
  channelsReady ??= (async () => {
    await LocalNotifications.createChannel({ id: "tasks", name: "Task updates", description: "Assignments, status changes, comments and mentions", importance: 4, visibility: 0 });
    await LocalNotifications.createChannel({ id: "deadlines", name: "Task deadlines", description: "Tasks due today or overdue", importance: 3, visibility: 0 });
  })().catch((err) => {
    channelsReady = null;
    throw err;
  });
  return channelsReady;
}

export const localNotifier: Notifier = {
  async permission() {
    if (!native()) return "denied";
    try {
      const r = await LocalNotifications.checkPermissions();
      return r.display === "granted" ? "granted" : r.display === "denied" ? "denied" : "prompt";
    } catch {
      return "denied";
    }
  },
  async ensurePermission() {
    if (!native()) return false;
    try {
      const cur = await LocalNotifications.checkPermissions();
      if (cur.display === "granted") return true;
      if (cur.display === "denied") return false;
      return (await LocalNotifications.requestPermissions()).display === "granted";
    } catch {
      return false;
    }
  },
  async show(plans) {
    if (!native() || plans.length === 0) return;
    await ensureChannels();
    await LocalNotifications.schedule({
      notifications: plans.map((p) => ({
        id: p.id,
        title: p.title,
        body: p.body,
        channelId: p.channel,
        group: p.group,
        groupSummary: false,
        autoCancel: true,
        smallIcon: "ic_stat_ff",
        ...(p.lines ? { inboxList: p.lines.slice(0, 5), summaryText: p.title } : {}),
        extra: { path: p.path, projectId: p.projectId },
      })),
    });
  },
  async scheduleDaily(items) {
    if (!native() || items.length === 0) return;
    await ensureChannels();
    await LocalNotifications.schedule({
      notifications: items.map((i) => ({
        id: i.id,
        title: i.title,
        body: i.body,
        channelId: "deadlines",
        group: i.group,
        autoCancel: true,
        smallIcon: "ic_stat_ff",
        schedule: { at: new Date(i.at), every: "day" as const, allowWhileIdle: true },
        extra: { path: i.path, projectId: i.projectId },
      })),
    });
  },
  async cancel(ids) {
    if (!native() || ids.length === 0) return;
    await LocalNotifications.cancel({ notifications: ids.map((id) => ({ id })) });
  },
};

/** What a tap carries: the hash route and the project it belongs to (absent on notifications raised before this field existed). */
export interface NotificationTap {
  path: string;
  projectId: string | null;
}

/** Parse a notification `extra`; null when it does not carry a usable route. */
export function parseTapExtra(extra: unknown): NotificationTap | null {
  const e = extra as { path?: unknown; projectId?: unknown } | null | undefined;
  if (typeof e?.path !== "string" || !e.path.startsWith("/")) return null;
  return { path: e.path, projectId: typeof e.projectId === "string" && e.projectId ? e.projectId : null };
}

const tapListeners = new Set<(tap: NotificationTap) => void>();

/** Deliver a tap to the subscribers (the OS listener below, and the e2e seam which has no way to press a real shade entry for another project). */
export function dispatchNotificationTap(tap: NotificationTap): void {
  for (const l of [...tapListeners]) l(tap);
}

/** Subscribe to taps. Returns the unsubscribe. */
export function onNotificationTap(cb: (tap: NotificationTap) => void): () => void {
  tapListeners.add(cb);
  const handle = native()
    ? LocalNotifications.addListener("localNotificationActionPerformed", (a) => {
        const tap = parseTapExtra(a.notification.extra);
        if (tap) dispatchNotificationTap(tap);
      })
    : null;
  return () => {
    tapListeners.delete(cb);
    void handle?.then((h) => h.remove());
  };
}
