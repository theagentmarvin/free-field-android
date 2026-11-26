import { describe, expect, it, vi } from "vitest";
import { MemoryBlobStore } from "../storage";
import { clearCache } from "./clearCache";
import { __resetPersistForTest, requestPersistence } from "./persist";
import { computeStorageUsage, formatBytes } from "./storageUsage";

describe("computeStorageUsage", () => {
  it("sums blob sizes and reads the origin estimate", async () => {
    const b = new MemoryBlobStore();
    await b.write("frag/a.frag", new Uint8Array(1000));
    await b.write("tiles/x/1.webp", new Uint8Array(24));
    const u = await computeStorageUsage(b, { estimate: async () => ({ usage: 5000, quota: 90000 }) });
    expect(u).toEqual({ blobBytes: 1024, blobCount: 2, originUsage: 5000, originQuota: 90000 });
  });
  it("copes with a missing or failing estimate", async () => {
    const b = new MemoryBlobStore();
    expect((await computeStorageUsage(b, undefined)).originUsage).toBeNull();
    const u = await computeStorageUsage(b, { estimate: async () => Promise.reject(new Error("x")) });
    expect(u).toMatchObject({ originUsage: null, originQuota: null, blobBytes: 0 });
  });
});

describe("formatBytes", () => {
  it("formats", () => {
    expect(formatBytes(null)).toBe("n/a");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(300 * 1024 * 1024)).toBe("300 MB");
  });
});

describe("requestPersistence", () => {
  it("reports granted, denied and unsupported", async () => {
    __resetPersistForTest();
    expect(await requestPersistence({ persist: async () => true, persisted: async () => false })).toBe("granted");
    expect(await requestPersistence({ persist: async () => false, persisted: async () => false })).toBe("denied");
    expect(await requestPersistence(undefined)).toBe("unsupported");
  });
  it("does not re-ask when already persisted, and maps errors to denied", async () => {
    const persist = vi.fn(async () => false);
    expect(await requestPersistence({ persist, persisted: async () => true })).toBe("granted");
    expect(persist).not.toHaveBeenCalled();
    expect(await requestPersistence({ persist: async () => Promise.reject(new Error("x")), persisted: async () => false })).toBe("denied");
  });
});

describe("clearCache", () => {
  it("removes cache prefixes only and reports what it freed", async () => {
    const b = new MemoryBlobStore();
    await b.write("tiles/p/0.webp", new Uint8Array(10));
    await b.write("cache/z", new Uint8Array(5));
    await b.write("frag/keep.frag", new Uint8Array(100));
    await b.write("photos/keep.jpg", new Uint8Array(7));
    expect(await clearCache(b)).toEqual({ files: 2, bytes: 15 });
    expect((await b.list()).map((x) => x.key).sort()).toEqual(["frag/keep.frag", "photos/keep.jpg"]);
  });
});
