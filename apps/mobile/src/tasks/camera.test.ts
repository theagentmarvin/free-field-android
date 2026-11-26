import { describe, expect, it } from "vitest";
import {
  classifyCameraError, consumeRecoveredCapture, handleRestoredResult, markCapturePending, peekRecoveredCapture, readCapturePending, type KvStore,
} from "./camera";

function memKv(): KvStore {
  const m = new Map<string, string>();
  return { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v), remove: async (k) => void m.delete(k) };
}

describe("camera errors", () => {
  it("classifies plugin rejections", () => {
    expect(classifyCameraError(new Error("User cancelled photos app"))).toBe("cancelled");
    expect(classifyCameraError(new Error("User denied access to camera"))).toBe("denied");
    expect(classifyCameraError("Camera permission is required")).toBe("denied");
    expect(classifyCameraError(new Error("boom"))).toBe("error");
  });
});

describe("activity-restore recovery", () => {
  it("parks a restored camera result for the draft that launched it", async () => {
    const kv = memKv();
    await markCapturePending({ draftId: "d1", source: "camera", startedAt: 1 }, kv);
    const rec = await handleRestoredResult({ pluginId: "Camera", methodName: "getPhoto", success: true, data: { webPath: "http://x/p.jpg" } }, kv);
    expect(rec).toEqual({ draftId: "d1", webPath: "http://x/p.jpg" });
    expect(await readCapturePending(kv)).toBeNull();
    expect(await consumeRecoveredCapture("other", kv)).toBeNull();
    expect(await peekRecoveredCapture(kv)).not.toBeNull();
    expect((await consumeRecoveredCapture("d1", kv))?.webPath).toBe("http://x/p.jpg");
    expect(await peekRecoveredCapture(kv)).toBeNull();
  });
  it("ignores failures, other plugins and unknown captures", async () => {
    const kv = memKv();
    await markCapturePending({ draftId: "d1", source: "camera", startedAt: 1 }, kv);
    expect(await handleRestoredResult({ pluginId: "Other", methodName: "x", success: true }, kv)).toBeNull();
    expect(await handleRestoredResult({ pluginId: "Camera", methodName: "getPhoto", success: false }, kv)).toBeNull();
    expect(await handleRestoredResult({ pluginId: "Camera", methodName: "getPhoto", success: true, data: { webPath: "w" } }, kv)).toBeNull();
  });
});

import { describePhotoError, explainCaptureError, isStorageFull, LOW_STORAGE_MESSAGE } from "./camera";

describe("storage-full photo errors", () => {
  it("recognises ENOSPC, quota and 'no space' failures from the filesystem plugin and the WebView", () => {
    expect(isStorageFull(new Error("Unable to write file: java.io.IOException: write failed: ENOSPC (No space left on device)"))).toBe(true);
    expect(isStorageFull({ name: "QuotaExceededError", message: "The quota has been exceeded." })).toBe(true);
    expect(isStorageFull({ name: "UnknownError", message: "Internal error opening backing store for indexedDB.open." })).toBe(true);
    expect(isStorageFull(new Error("network down"))).toBe(false);
  });
  it("gives a specific message and keeps other errors visible", () => {
    expect(describePhotoError(new Error("ENOSPC"))).toBe(LOW_STORAGE_MESSAGE);
    expect(describePhotoError(new Error("decode failed"))).toBe("Could not add the photo: decode failed");
  });
});

describe("explainCaptureError", () => {
  const gone = new Error("No such image found");
  it("blames a nearly full device for a misleading plugin error", async () => {
    expect(await explainCaptureError(gone, async () => 16 * 1024 * 1024)).toBe(LOW_STORAGE_MESSAGE);
  });
  it("keeps the plugin text when there is plenty of space or the space is unknown", async () => {
    expect(await explainCaptureError(gone, async () => 2 * 1024 ** 3)).toBe("No such image found");
    expect(await explainCaptureError(gone, async () => null)).toBe("No such image found");
  });
  it("recognises an explicit ENOSPC without probing", async () => {
    expect(await explainCaptureError(new Error("ENOSPC"), async () => { throw new Error("must not be called"); })).toBe(LOW_STORAGE_MESSAGE);
  });
});
