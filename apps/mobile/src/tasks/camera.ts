import { App } from "@capacitor/app";
import { Camera, CameraResultType, CameraSource } from "@capacitor/camera";
import { Capacitor } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";
import { FfmFiles } from "../storage/ffmFiles";

/**
 * Photo capture for tasks: camera or gallery through `@capacitor/camera`,
 * plus the two Android-specific failure modes the field app must survive:
 *
 *  - permission denial: reported as a typed result, never thrown, so the UI
 *    can show a friendly message and offer the gallery instead;
 *  - the system killing our activity while the camera app is in front: the
 *    capture is marked pending before launch, and when the WebView comes back
 *    `appRestoredResult` hands us the photo, which we park until the compose
 *    screen consumes it (see `recoverCapture`).
 */
export type CaptureSource = "camera" | "gallery";

export type CaptureFailure = "cancelled" | "denied" | "unavailable" | "error";

export type CaptureResult = { ok: true; blob: Blob } | { ok: false; reason: CaptureFailure; message?: string };

/** Map a rejected plugin call to a typed reason. */
export function classifyCameraError(err: unknown): CaptureFailure {
  const msg = String((err as { message?: unknown } | null)?.message ?? err ?? "").toLowerCase();
  if (/cancel/.test(msg)) return "cancelled";
  if (/denied|permission/.test(msg)) return "denied";
  if (/not available|no camera|unimplemented|not implemented/.test(msg)) return "unavailable";
  return "error";
}

export const DENIED_MESSAGE =
  "Camera access is turned off for FreeField. Allow it in Android settings (App info > Permissions), or choose a photo from the gallery instead.";

// ── pending / recovered state (survives process death) ───────────────────

export interface KvStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export const preferencesKv: KvStore = {
  async get(key) {
    return (await Preferences.get({ key })).value;
  },
  async set(key, value) {
    await Preferences.set({ key, value });
  },
  async remove(key) {
    await Preferences.remove({ key });
  },
};

const PENDING_KEY = "ffm.tasks.pendingCapture";
const RECOVERED_KEY = "ffm.tasks.recoveredCapture";

export interface PendingCapture {
  draftId: string;
  source: CaptureSource;
  startedAt: number;
}

export interface RecoveredCapture {
  draftId: string;
  webPath: string;
}

async function readJson<T>(kv: KvStore, key: string): Promise<T | null> {
  try {
    const raw = await kv.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export const markCapturePending = (p: PendingCapture, kv: KvStore = preferencesKv) =>
  kv.set(PENDING_KEY, JSON.stringify(p));
export const clearCapturePending = (kv: KvStore = preferencesKv) => kv.remove(PENDING_KEY);
export const readCapturePending = (kv: KvStore = preferencesKv) => readJson<PendingCapture>(kv, PENDING_KEY);

/**
 * What to do with an `appRestoredResult` event. Pure so it can be tested: a
 * successful camera result becomes a recovered capture bound to the draft that
 * launched it; anything else is dropped.
 */
export async function handleRestoredResult(
  ev: { pluginId?: string; methodName?: string; success?: boolean; data?: { webPath?: string } | null },
  kv: KvStore = preferencesKv,
): Promise<RecoveredCapture | null> {
  if (ev.pluginId !== "Camera" || ev.methodName !== "getPhoto") return null;
  const pending = await readCapturePending(kv);
  await clearCapturePending(kv);
  if (!ev.success || !ev.data?.webPath || !pending) return null;
  const rec: RecoveredCapture = { draftId: pending.draftId, webPath: ev.data.webPath };
  await kv.set(RECOVERED_KEY, JSON.stringify(rec));
  return rec;
}

export const peekRecoveredCapture = (kv: KvStore = preferencesKv) => readJson<RecoveredCapture>(kv, RECOVERED_KEY);

/** Read-and-clear. When `draftId` is given only a capture for that draft is consumed. */
export async function consumeRecoveredCapture(
  draftId?: string,
  kv: KvStore = preferencesKv,
): Promise<RecoveredCapture | null> {
  const rec = await peekRecoveredCapture(kv);
  if (!rec || (draftId && rec.draftId !== draftId)) return null;
  await kv.remove(RECOVERED_KEY);
  return rec;
}

let recoveryStarted = false;
const recoveryListeners = new Set<(r: RecoveredCapture) => void>();

/** Idempotent; registers the `appRestoredResult` listener once at module load. */
export function initCaptureRecovery(): void {
  if (recoveryStarted || !Capacitor.isNativePlatform()) return;
  recoveryStarted = true;
  void App.addListener("appRestoredResult", (ev) => {
    void handleRestoredResult(ev as Parameters<typeof handleRestoredResult>[0]).then((rec) => {
      if (rec) recoveryListeners.forEach((l) => l(rec));
    });
  });
}

export function onCaptureRecovered(cb: (r: RecoveredCapture) => void): () => void {
  recoveryListeners.add(cb);
  return () => recoveryListeners.delete(cb);
}

// ── capture ──────────────────────────────────────────────────────────────

export async function fetchWebPath(webPath: string): Promise<Blob> {
  const res = await fetch(webPath);
  if (!res.ok) throw new Error(`photo read failed (${res.status})`);
  return res.blob();
}

export async function cameraPermissionState(): Promise<"granted" | "denied" | "prompt"> {
  try {
    const p = await Camera.checkPermissions();
    const s = p.camera;
    return s === "granted" ? "granted" : s === "denied" ? "denied" : "prompt";
  } catch {
    return "prompt";
  }
}

/**
 * Take a photo or pick one from the gallery. The caller must have saved its
 * draft first: `draftId` is what an activity restore re-opens.
 */
export async function capturePhoto(source: CaptureSource, draftId: string): Promise<CaptureResult> {
  if (source === "camera" && (await cameraPermissionState()) === "denied") {
    return { ok: false, reason: "denied", message: DENIED_MESSAGE };
  }
  await markCapturePending({ draftId, source, startedAt: Date.now() }).catch(() => undefined);
  try {
    const photo = await Camera.getPhoto({
      source: source === "camera" ? CameraSource.Camera : CameraSource.Photos,
      resultType: CameraResultType.Uri,
      quality: 90,
      correctOrientation: true,
      saveToGallery: false,
    });
    if (!photo.webPath) return { ok: false, reason: "error", message: "The camera returned no photo." };
    const blob = await fetchWebPath(photo.webPath);
    return { ok: true, blob };
  } catch (err) {
    const reason = classifyCameraError(err);
    if (reason === "denied" || reason === "cancelled") return { ok: false, reason, message: reason === "denied" ? DENIED_MESSAGE : undefined };
    return { ok: false, reason, message: await explainCaptureError(err, freeBytesOrNull) };
  } finally {
    await clearCapturePending().catch(() => undefined);
  }
}

/** Below this much free space a failed capture is blamed on storage (the plugin's own text is misleading then). */
export const LOW_STORAGE_BYTES = 32 * 1024 * 1024;

async function freeBytesOrNull(): Promise<number | null> {
  if (!Capacitor.isNativePlatform()) return null;
  try {
    return (await FfmFiles.freeSpace()).free;
  } catch {
    return null;
  }
}

/**
 * The camera/picker plugins copy the picture into the app cache and report a full disk as an unrelated error
 * ("No such image found", BUG-10). Name the real cause when the device is nearly full; otherwise keep their text.
 */
export async function explainCaptureError(err: unknown, free: () => Promise<number | null>): Promise<string> {
  if (isStorageFull(err)) return LOW_STORAGE_MESSAGE;
  const bytes = await free();
  if (bytes !== null && bytes < LOW_STORAGE_BYTES) return LOW_STORAGE_MESSAGE;
  return String((err as Error)?.message ?? err);
}

export const LOW_STORAGE_MESSAGE =
  "There is not enough free storage on this device to keep the photo. Free some space (delete unused files or apps) and try again. Your draft is kept.";

/** True when a failure looks like the device (or the WebView quota) ran out of space. */
export function isStorageFull(err: unknown): boolean {
  const msg = `${(err as { name?: unknown } | null)?.name ?? ""} ${(err as { message?: unknown } | null)?.message ?? err ?? ""}`;
  // "Internal error opening backing store for indexedDB.open": what the WebView reports once the disk is full
  return /ENOSPC|no space left|not enough space|insufficient storage|disk (is )?full|QuotaExceeded|quota|backing store/i.test(msg);
}

/** User-facing text for a failed "add photo" step. */
export function describePhotoError(err: unknown): string {
  return isStorageFull(err) ? LOW_STORAGE_MESSAGE : `Could not add the photo: ${String((err as Error)?.message ?? err)}`;
}
