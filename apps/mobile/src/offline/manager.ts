import { buildPlan, estimateBytes, pendingUpdates, supersededItems, type PlanRows } from "./plan";
import type { OfflineDb } from "./journal";
import {
  IntegrityError,
  OfflineRefusal,
  type DownloadUrl,
  type ErrorKind,
  type NetworkInfo,
  type OfflineFiles,
  type OfflineItem,
  type OfflinePackage,
  type OfflineSettings,
  type PlanDownloadedEvent,
  type PlanItem,
} from "./types";

export interface ManagerDeps {
  journal: OfflineDb;
  files: OfflineFiles;
  /** Resolve a Storage path to a downloadable URL (fresh on every (re)start). */
  urlFor(storagePath: string): Promise<DownloadUrl>;
  /** Read the synced metadata rows of a building. */
  loadRows(buildingId: string): Promise<PlanRows>;
  buildingName(buildingId: string): Promise<string>;
  network(): NetworkInfo;
  settings(): OfflineSettings;
  now?(): number;
  /** Max parallel file downloads. */
  concurrency?: number;
  /** Persist progress at most this often (ms). */
  persistEveryMs?: number;
  onPlanDownloaded?(e: PlanDownloadedEvent): void;
  /** Fires after every PDF/frag lands (generic hook). */
  onItemDone?(item: OfflineItem): void;
  log?(msg: string): void;
  /**
   * Stall watchdog: abort a download that moved no bytes and changed no state for this long (ms). Default
   * {@link DEFAULT_STALL_MS}; 0 turns the watchdog off. Tests override it.
   */
  stallMs?: number;
  /** Reachability evidence: `false` after a network-class failure, `true` once bytes flow or an item lands. */
  onReachability?(reachable: boolean): void;
}

/** No bytes and no state change for this long while "downloading" counts as a stall (BUG-12b). */
export const DEFAULT_STALL_MS = 30_000;
/** Below this much free space a stall is reported as "storage full" rather than "network". */
export const LOW_FREE_BYTES = 32 * 1024 * 1024;
export const STORAGE_FULL_MESSAGE =
  "The device is out of storage. Free some space (delete unused files or apps), then tap Retry. Nothing already downloaded is lost.";

/** Extra headroom on top of the bytes still to download. */
export const STORAGE_MARGIN_BYTES = 50 * 1024 * 1024;
export const STORAGE_MARGIN_FRACTION = 0.05;

const isAbort = (e: unknown) => (e as Error)?.name === "AbortError";

function classify(e: unknown): { kind: ErrorKind; message: string } {
  if (e instanceof IntegrityError) return { kind: "integrity", message: e.message };
  const msg = String((e as Error)?.message ?? e);
  if (/^HTTP \d+/.test(msg)) return { kind: "http", message: msg };
  if (/ENOSPC|No space|storage/i.test(msg)) return { kind: "storage", message: msg };
  if (/network|timeout|timed out|connection|reset|abort|unable to resolve|failed to connect|socket|EOF|unexpected end/i.test(msg))
    return { kind: "network", message: msg };
  return { kind: "other", message: msg };
}

export class DownloadManager {
  private project: string | null = null;
  private running = new Map<string, AbortController>(); // itemId -> controller
  private reason = new Map<string, "pause" | "cancel" | "project">();
  private slots = 0;
  private waiters: Array<() => void> = [];
  private lastPersist = new Map<string, number>();
  private runs = new Set<Promise<void>>();
  /** Last byte progress / state transition per running item (stall watchdog). */
  private activity = new Map<string, { at: number; bytes: number }>();
  /** Controllers whose item was given up by the watchdog: their late results must not touch state. */
  private stalled = new WeakSet<AbortController>();
  private watchdog: ReturnType<typeof setInterval> | null = null;
  /**
   * In-memory copy of rows whose journal write failed (the WebView's IndexedDB can stay broken after the disk filled).
   * Reads merge these over the journal so the UI and Retry still work without a restart.
   */
  private memItems = new Map<string, OfflineItem>();
  private pkgCache = new Map<string, OfflinePackage>();
  private memVersion = 0;
  private memListeners = new Set<() => void>();

  constructor(private deps: ManagerDeps) {}

  /** Subscribe to in-memory state changes (journal failures); used with {@link snapshot}. */
  subscribeMemory = (cb: () => void): (() => void) => {
    this.memListeners.add(cb);
    return () => this.memListeners.delete(cb);
  };
  memoryVersion = (): number => this.memVersion;
  private bumpMem() {
    this.memVersion++;
    this.memListeners.forEach((l) => l());
  }

  /** Journal rows of a project merged with the in-memory overrides. Never throws when the journal is unreadable. */
  async snapshot(projectId: string): Promise<{ pkgs: OfflinePackage[]; items: OfflineItem[] }> {
    let pkgs: OfflinePackage[] = [];
    let items: OfflineItem[] = [];
    try {
      [pkgs, items] = await Promise.all([
        this.journal.packages.where("projectId").equals(projectId).toArray(),
        this.journal.items.where("projectId").equals(projectId).toArray(),
      ]);
      for (const p of pkgs) this.pkgCache.set(p.buildingId, p);
    } catch (e) {
      this.deps.log?.(`journal unreadable: ${String(e)}`);
      pkgs = [...this.pkgCache.values()].filter((p) => p.projectId === projectId);
    }
    const byId = new Map(items.map((i) => [i.id, i]));
    for (const m of this.memItems.values()) if (m.projectId === projectId) byId.set(m.id, m);
    return { pkgs, items: [...byId.values()] };
  }

  /** Items of a building: journal rows (empty when unreadable) overlaid with the in-memory rows. */
  private async itemsOf(buildingId: string): Promise<OfflineItem[]> {
    let rows: OfflineItem[] = [];
    try {
      rows = await this.journal.items.where("buildingId").equals(buildingId).toArray();
    } catch (e) {
      this.deps.log?.(`journal unreadable: ${String(e)}`);
    }
    const byId = new Map(rows.map((i) => [i.id, i]));
    for (const m of this.memItems.values()) if (m.buildingId === buildingId) byId.set(m.id, m);
    return [...byId.values()];
  }

  private async itemById(id: string): Promise<OfflineItem | undefined> {
    const m = this.memItems.get(id);
    if (m) return m;
    try {
      return await this.journal.items.get(id);
    } catch {
      return undefined;
    }
  }

  /** Write a row; when the journal refuses, keep it in memory so state is not lost. */
  private async writeItem(item: OfflineItem): Promise<void> {
    try {
      await this.journal.items.put({ ...item });
      if (this.memItems.delete(item.id)) this.bumpMem();
    } catch (e) {
      this.deps.log?.(`journal write failed, holding ${item.id} in memory: ${String(e)}`);
      this.memItems.set(item.id, { ...item });
      this.bumpMem();
    }
  }

  private get stallMs(): number {
    return this.deps.stallMs ?? DEFAULT_STALL_MS;
  }

  private touch(id: string, bytes?: number) {
    const a = this.activity.get(id);
    this.activity.set(id, { at: this.now(), bytes: bytes ?? a?.bytes ?? 0 });
  }

  private startWatchdog() {
    if (this.watchdog || this.stallMs <= 0) return;
    const every = Math.max(50, Math.min(5_000, Math.floor(this.stallMs / 4)));
    this.watchdog = setInterval(() => void this.checkStalls().catch((e) => this.deps.log?.(`watchdog: ${String(e)}`)), every);
  }

  private stopWatchdog() {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
  }

  /** One watchdog pass (the interval calls it; tests call it with a fake clock). Returns the ids it gave up on. */
  async checkStalls(): Promise<string[]> {
    const limit = this.stallMs;
    if (limit <= 0) return [];
    const out: string[] = [];
    for (const [id, ctl] of [...this.running]) {
      const a = this.activity.get(id);
      const item = await this.itemById(id);
      if (!a || !item || item.status !== "downloading" || this.stalled.has(ctl) || this.reason.has(id)) continue;
      if (this.now() - a.at < limit) continue;
      out.push(id);
      await this.failStalled(id, ctl, item);
    }
    return out;
  }

  private async failStalled(id: string, ctl: AbortController, item: OfflineItem): Promise<void> {
    this.stalled.add(ctl);
    ctl.abort();
    // Give the transfer a moment to unwind; a hung native call must not keep the item locked forever.
    for (let i = 0; i < 20 && this.running.get(id) === ctl; i++) await new Promise((r) => setTimeout(r, 25));
    if (this.running.get(id) === ctl) {
      this.running.delete(id);
      this.reason.delete(id);
    }
    this.activity.delete(id);
    this.lastPersist.delete(id);
    let free: number | null = null;
    try {
      free = await Promise.race([this.deps.files.freeBytes(), new Promise<null>((r) => setTimeout(() => r(null), 3_000))]);
    } catch {
      free = null;
    }
    const full = free !== null && free < LOW_FREE_BYTES;
    const message = full ? STORAGE_FULL_MESSAGE : `The download stalled (no data for ${Math.round(this.stallMs / 1000)} s). Check the connection and tap Retry.`;
    this.deps.log?.(`download ${id} stalled at ${item.bytesDone}/${item.size} (free ${free ?? "unknown"}): ${full ? "storage" : "network"}`);
    if (!full) this.deps.onReachability?.(false);
    // Verified files are untouched: only this item's row changes, and the partial file stays for the resume.
    await this.writeItem({ ...item, status: "error", error: message, errorKind: full ? "storage" : "network", updatedAt: this.now() });
  }

  private now = () => (this.deps.now ?? Date.now)();
  private get journal() {
    return this.deps.journal;
  }

  // ── queries ───────────────────────────────────────────────

  async plan(buildingId: string): Promise<PlanItem[]> {
    return buildPlan(await this.deps.loadRows(buildingId));
  }

  /** Bytes still to download for a building (what the "Make available offline" button shows). */
  async estimate(buildingId: string): Promise<{ items: number; bytes: number; remainingBytes: number }> {
    const plan = await this.plan(buildingId);
    const have = await this.journal.items.where("buildingId").equals(buildingId).toArray();
    const todo = pendingUpdates(plan, have);
    return { items: plan.length, bytes: estimateBytes(plan), remainingBytes: estimateBytes(todo) };
  }

  /** Resolves once every download started so far has settled (tests / e2e). */
  async idle(): Promise<void> {
    while (this.runs.size) await Promise.all([...this.runs]);
  }

  // ── commands ──────────────────────────────────────────────

  /** Switch the active project: downloads of any other project stop (parts are kept), this project's resume. */
  async setProject(projectId: string | null): Promise<void> {
    this.project = projectId;
    for (const [id, ctl] of this.running) {
      const item = await this.journal.items.get(id);
      if (!item || item.projectId !== projectId) {
        this.reason.set(id, "project");
        ctl.abort();
      }
    }
    await this.settle();
    if (projectId) await this.resumeInterrupted();
  }

  private async settle() {
    while (this.running.size && [...this.running.keys()].some((k) => this.reason.has(k))) {
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  /** Make a building available offline (or fetch its pending updates). Throws OfflineRefusal. */
  async start(buildingId: string, projectId: string, opts: { auto?: boolean } = {}): Promise<void> {
    const plan = await this.plan(buildingId);
    if (plan.length === 0) throw new OfflineRefusal("nothing-to-download", "This building has no plans or models uploaded yet.");
    const net = this.deps.network();
    if (!net.online) throw new OfflineRefusal("offline", "You are offline. Connect to download.");
    if (this.deps.settings().wifiOnly && !isWifi(net)) {
      throw new OfflineRefusal("wifi-only", "Wi-Fi only is on and this device is not on Wi-Fi. Connect to Wi-Fi or turn the setting off.");
    }
    const existing = await this.journal.items.where("buildingId").equals(buildingId).toArray();
    const todo = pendingUpdates(plan, existing);
    if (todo.length === 0) {
      await this.finishPackage(buildingId, plan);
      return;
    }
    // Storage-low check: remaining bytes (already-downloaded parts count) + headroom.
    let need = 0;
    for (const p of todo) need += Math.max(0, p.size - (await this.deps.files.partSize(p.key)));
    const required = need + Math.max(STORAGE_MARGIN_BYTES, Math.round(need * STORAGE_MARGIN_FRACTION));
    const free = await this.deps.files.freeBytes();
    if (free < required) {
      throw new OfflineRefusal(
        "low-storage",
        `Not enough free space: this needs about ${fmt(required)} and only ${fmt(free)} is free. Free up space and try again.`,
      );
    }
    const t = this.now();
    const prev = await this.journal.packages.get(buildingId);
    await this.journal.packages.put({
      buildingId,
      projectId,
      name: await this.deps.buildingName(buildingId),
      pausedBy: null,
      updateAvailable: prev?.updateAvailable ?? false,
      createdAt: prev?.createdAt ?? t,
      updatedAt: t,
    });
    for (const p of todo) {
      if (this.running.has(p.id)) continue;
      const old = existing.find((e) => e.id === p.id);
      const bytesDone = old && old.errorKind !== "integrity" ? old.bytesDone : 0;
      await this.journal.items.put({ ...p, projectId, buildingId, status: "queued", bytesDone, updatedAt: t });
    }
    void opts;
    this.launch(buildingId);
  }

  pause(buildingId: string, by: "user" | "network" = "user"): Promise<void> {
    return this.stopBuilding(buildingId, "pause", by);
  }

  async resume(buildingId: string): Promise<void> {
    const pkg = await this.journal.packages.get(buildingId);
    if (!pkg) return;
    const net = this.deps.network();
    if (!net.online) throw new OfflineRefusal("offline", "You are offline. Connect to download.");
    if (this.deps.settings().wifiOnly && !isWifi(net)) throw new OfflineRefusal("wifi-only", "Wi-Fi only is on and this device is not on Wi-Fi.");
    await this.journal.packages.update(buildingId, { pausedBy: null, updatedAt: this.now() });
    await this.journal.items
      .where("buildingId")
      .equals(buildingId)
      .filter((i) => i.status === "paused" || i.status === "downloading" || i.status === "verifying")
      .modify({ status: "queued" });
    this.launch(buildingId);
  }

  /** Re-queue failed items (integrity failures restart from zero). */
  async retryFailed(buildingId: string): Promise<void> {
    const failed = (await this.itemsOf(buildingId)).filter((i) => i.status === "error");
    if (failed.some((i) => i.errorKind === "storage")) {
      // Do not restart a transfer that would stall again: check the space the user was asked to free.
      const free = await this.deps.files.freeBytes().catch(() => null);
      if (free !== null && free < LOW_FREE_BYTES) {
        throw new OfflineRefusal("low-storage", `Still not enough free space (${fmt(free)} free). Free up some space and tap Retry again.`);
      }
    }
    for (const i of failed) {
      if (i.errorKind === "integrity") await this.deps.files.discardPart(i.key);
      await this.writeItem({ ...i, status: "queued", error: undefined, errorKind: undefined, bytesDone: i.errorKind === "integrity" ? 0 : i.bytesDone });
    }
    const pkg = await this.journal.packages.get(buildingId).catch(() => this.pkgCache.get(buildingId));
    if (pkg?.pausedBy) await this.resume(buildingId);
    else this.launch(buildingId);
  }

  /** Abort and forget a building's downloads; partial files are deleted, finished files stay (use remove). */
  async cancel(buildingId: string): Promise<void> {
    // Snapshot first: aborted workers delete their own journal rows.
    const items = await this.journal.items.where("buildingId").equals(buildingId).toArray();
    await this.stopBuilding(buildingId, "cancel", null);
    for (const i of items) {
      if (i.status !== "done") {
        await this.deps.files.discardPart(i.key);
        await this.journal.items.delete(i.id);
      }
    }
    const left = await this.journal.items.where("buildingId").equals(buildingId).count();
    if (left === 0) await this.journal.packages.delete(buildingId);
  }

  /** "Remove offline copy": stop, delete every file and journal row of the building. */
  async remove(buildingId: string): Promise<void> {
    const items = await this.journal.items.where("buildingId").equals(buildingId).toArray();
    await this.stopBuilding(buildingId, "cancel", null);
    for (const i of items) {
      await this.deps.files.discardPart(i.key);
      await this.deps.files.remove(i.key);
    }
    await this.journal.items.where("buildingId").equals(buildingId).delete();
    await this.journal.packages.delete(buildingId);
  }

  /** Called at app start and on project switch: continue what a kill/stop interrupted. */
  async resumeInterrupted(): Promise<void> {
    if (!this.project) return;
    const net = this.deps.network();
    if (!net.online) return;
    const pkgs = await this.journal.packages.where("projectId").equals(this.project).toArray();
    for (const pkg of pkgs) {
      if (pkg.pausedBy === "user") continue;
      if (this.deps.settings().wifiOnly && !isWifi(net)) continue;
      if (pkg.pausedBy === "network") await this.journal.packages.update(pkg.buildingId, { pausedBy: null });
      const items = await this.journal.items.where("buildingId").equals(pkg.buildingId).toArray();
      const open = items.filter((i) => i.status === "queued" || i.status === "downloading" || i.status === "verifying" || i.status === "paused");
      // Network-type failures are retried automatically; integrity failures wait for the user.
      const retry = items.filter((i) => i.status === "error" && (i.errorKind === "network" || i.errorKind === "http"));
      if (open.length + retry.length === 0) continue;
      for (const i of [...open, ...retry]) await this.journal.items.update(i.id, { status: "queued", error: undefined, errorKind: undefined });
      this.launch(pkg.buildingId);
    }
  }

  /** The network changed (type or reachability): honour Wi-Fi-only, resume after a regain. */
  async onNetworkChange(): Promise<void> {
    const net = this.deps.network();
    const gated = !net.online || (this.deps.settings().wifiOnly && !isWifi(net));
    if (gated) {
      const active = new Set<string>();
      for (const id of this.running.keys()) {
        const it = await this.journal.items.get(id);
        if (it) active.add(it.buildingId);
      }
      for (const b of active) await this.pause(b, "network");
    } else {
      await this.resumeInterrupted();
      await this.checkUpdates();
    }
  }

  /**
   * Look for newer versions of every offline building of the current project (call after the metadata sync
   * applied changes, on resume and on network regain). Flags `updateAvailable`; downloads when the
   * auto-update setting is on and the device is on Wi-Fi.
   */
  async checkUpdates(): Promise<string[]> {
    if (!this.project) return [];
    const changed: string[] = [];
    const pkgs = await this.journal.packages.where("projectId").equals(this.project).toArray();
    for (const pkg of pkgs) {
      const plan = await this.plan(pkg.buildingId);
      const items = await this.journal.items.where("buildingId").equals(pkg.buildingId).toArray();
      const pending = pendingUpdates(plan, items);
      const stale = supersededItems(plan, items);
      const hasUpdate = plan.length > 0 && (pending.length > 0 || stale.length > 0) && items.some((i) => i.status === "done");
      const downloading = items.some((i) => i.status === "queued" || i.status === "downloading" || i.status === "verifying");
      if (hasUpdate && !pkg.updateAvailable) await this.journal.packages.update(pkg.buildingId, { updateAvailable: true });
      if (!hasUpdate && pkg.updateAvailable && !downloading) await this.journal.packages.update(pkg.buildingId, { updateAvailable: false });
      if (!hasUpdate) continue;
      changed.push(pkg.buildingId);
      const net = this.deps.network();
      if (this.deps.settings().autoUpdate && net.online && isWifi(net) && pkg.pausedBy !== "user" && !downloading) {
        try {
          await this.start(pkg.buildingId, pkg.projectId, { auto: true });
        } catch (e) {
          this.deps.log?.(`auto-update skipped: ${(e as Error).message}`);
        }
      }
    }
    return changed;
  }

  // ── engine ────────────────────────────────────────────────

  private async stopBuilding(buildingId: string, why: "pause" | "cancel", by: "user" | "network" | null): Promise<void> {
    const items = await this.journal.items.where("buildingId").equals(buildingId).toArray();
    if (why === "pause") await this.journal.packages.update(buildingId, { pausedBy: by, updatedAt: this.now() });
    for (const i of items) {
      const ctl = this.running.get(i.id);
      if (ctl) {
        this.reason.set(i.id, why);
        ctl.abort();
      } else if (why === "pause" && (i.status === "queued" || i.status === "downloading")) {
        await this.journal.items.update(i.id, { status: "paused" });
      }
    }
    while (items.some((i) => this.running.has(i.id))) await new Promise((r) => setTimeout(r, 5));
  }

  private launch(buildingId: string): void {
    const run = (async () => {
      const items = (await this.itemsOf(buildingId)).filter((i) => i.status === "queued" && !this.running.has(i.id));
      if (items.length === 0) return;
      void this.deps.files.keepAwake?.(true);
      this.startWatchdog();
      // Smaller files first: plans become usable early, the big model streams last.
      items.sort((a, b) => a.size - b.size);
      await Promise.all(items.map((i) => this.withSlot(() => this.processItem(i.id))));
      await this.afterRun(buildingId);
    })()
      .catch((e) => this.deps.log?.(`download run failed: ${String(e)}`))
      .finally(() => {
        this.runs.delete(run);
        if (this.running.size === 0) {
          void this.deps.files.keepAwake?.(false);
          this.stopWatchdog();
        }
      });
    this.runs.add(run);
  }

  private async withSlot<T>(fn: () => Promise<T>): Promise<T> {
    const max = this.deps.concurrency ?? 2;
    while (this.slots >= max) await new Promise<void>((r) => this.waiters.push(r));
    this.slots++;
    try {
      return await fn();
    } finally {
      this.slots--;
      this.waiters.shift()?.();
    }
  }

  private async afterRun(buildingId: string): Promise<void> {
    const items = await this.itemsOf(buildingId);
    if (items.length === 0 || items.some((i) => i.status !== "done")) return;
    await this.finishPackage(buildingId, await this.plan(buildingId));
  }

  /** All current-plan items are on disk: drop superseded versions and clear the update flag. */
  private async finishPackage(buildingId: string, plan: PlanItem[]): Promise<void> {
    const items = await this.journal.items.where("buildingId").equals(buildingId).toArray();
    for (const old of supersededItems(plan, items)) {
      await this.deps.files.remove(old.key);
      await this.journal.items.delete(old.id);
    }
    if (await this.journal.packages.get(buildingId)) await this.journal.packages.update(buildingId, { updateAvailable: false });
  }

  private async persist(item: OfflineItem, patch: Partial<OfflineItem>, force = false): Promise<void> {
    const t = this.now();
    Object.assign(item, patch);
    if (patch.status) this.touch(item.id);
    const last = this.lastPersist.get(item.id) ?? 0;
    if (!force && t - last < (this.deps.persistEveryMs ?? 500)) return;
    this.lastPersist.set(item.id, t);
    if (this.memItems.has(item.id)) {
      // The journal refused an earlier write: keep the whole row in memory and retry the journal opportunistically.
      await this.writeItem({ ...item, updatedAt: t });
      return;
    }
    try {
      await this.journal.items.update(item.id, { ...patch, bytesDone: item.bytesDone, updatedAt: t });
    } catch (e) {
      // Disk full: the journal cannot be written. Hold the row in memory; the download itself is not affected.
      this.deps.log?.(`journal write failed, holding ${item.id} in memory: ${String(e)}`);
      this.memItems.set(item.id, { ...item, updatedAt: t });
      this.bumpMem();
    }
  }

  private async processItem(id: string): Promise<void> {
    const item = await this.itemById(id);
    if (!item || item.status !== "queued") return;
    const ctl = new AbortController();
    this.running.set(id, ctl);
    this.touch(id, item.bytesDone);
    const { files } = this.deps;
    try {
      // Finished file already there (crash between rename and journal write)? Trust only if it re-hashes.
      const finalSize = await files.size(item.key);
      if (finalSize === item.size) {
        const h = await files.hash(item.key, false);
        if (h.sha256 === item.sha256) return this.markDone(item);
        await files.remove(item.key);
      }
      let offset = await files.partSize(item.key);
      if (offset > item.size) {
        await files.discardPart(item.key);
        offset = 0;
      }
      await this.persist(item, { status: "downloading", bytesDone: offset, error: undefined, errorKind: undefined }, true);
      if (offset < item.size) {
        const target = await this.deps.urlFor(item.storagePath);
        if (ctl.signal.aborted) throw abortError();
        await files.download({
          id,
          url: target.url,
          headers: target.headers,
          key: item.key,
          offset,
          signal: ctl.signal,
          onProgress: (bytes) => {
            if (this.stalled.has(ctl)) return;
            const a = this.activity.get(id);
            if (!a || bytes > a.bytes) {
              if (!a || a.bytes <= offset) this.deps.onReachability?.(true); // first bytes of this attempt
              this.touch(id, bytes);
            }
            this.persist(item, { bytesDone: Math.min(bytes, item.size) }).catch(() => undefined);
          },
        });
      }
      await this.persist(item, { status: "verifying", bytesDone: item.size }, true);
      const h = await files.hash(item.key, true);
      if (h.size !== item.size) throw new IntegrityError(`size ${h.size} does not match the expected ${item.size}`);
      if (h.sha256 !== item.sha256) throw new IntegrityError("checksum does not match the published file");
      await files.commit(item.key);
      await this.markDone(item);
    } catch (e) {
      if (this.stalled.has(ctl)) return; // the watchdog already recorded the outcome
      const why = this.reason.get(id);
      if (isAbort(e) || why) {
        if (why === "pause") await this.persist(item, { status: "paused" }, true);
        else if (why === "project") await this.persist(item, { status: "queued" }, true);
        else if (why === "cancel") await this.journal.items.delete(id).catch(() => undefined);
        return;
      }
      const c = classify(e);
      if (c.kind === "integrity") await files.discardPart(item.key).catch(() => undefined);
      if (c.kind === "network") this.deps.onReachability?.(false);
      await this.persist(item, { status: "error", error: c.kind === "storage" ? STORAGE_FULL_MESSAGE : c.message, errorKind: c.kind, ...(c.kind === "integrity" ? { bytesDone: 0 } : {}) }, true);
      this.deps.log?.(`download ${id} failed (${c.kind}): ${c.message}`);
    } finally {
      if (this.running.get(id) === ctl) {
        this.running.delete(id);
        this.reason.delete(id);
        this.lastPersist.delete(id);
        this.activity.delete(id);
      }
    }
  }

  private async markDone(item: OfflineItem): Promise<void> {
    await this.persist(item, { status: "done", bytesDone: item.size, error: undefined, errorKind: undefined }, true);
    this.deps.onReachability?.(true);
    this.deps.onItemDone?.(item);
    if (item.kind === "pdf") {
      try {
        this.deps.onPlanDownloaded?.({
          projectId: item.projectId,
          buildingId: item.buildingId,
          pdfFileId: item.fileId,
          versionId: item.versionId,
          versionNumber: item.versionNumber,
          key: item.key,
          sha256: item.sha256,
          size: item.size,
        });
      } catch (e) {
        this.deps.log?.(`onPlanDownloaded hook threw: ${String(e)}`);
      }
    }
  }
}

function abortError(): Error {
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
}

export function isWifi(n: NetworkInfo): boolean {
  return n.connectionType === "wifi" || n.connectionType === "ethernet";
}

export function fmt(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export type { OfflinePackage };
