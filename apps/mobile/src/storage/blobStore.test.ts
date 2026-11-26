import { describe, expect, it } from "vitest";
import { BlobIntegrityError, InvalidBlobKeyError, type BlobStore } from "./blobStore";
import { CapacitorBlobStore, type FsApi } from "./capacitorBlobStore";
import { MemoryBlobStore } from "./memoryBlobStore";
import { base64ToBytes } from "./base64";
import { sha256Hex } from "./sha256";

/** Minimal in-memory stand-in for the Capacitor Filesystem plugin. */
function fakeFs(hooks: { failRename?: boolean; refuseOverwrite?: boolean } = {}) {
  const files = new Map<string, Uint8Array>();
  const missing = (p: string) => new Error(`File does not exist: ${p}`);
  const api = {
    async writeFile({ path, data }: { path: string; data: unknown }) {
      files.set(path, base64ToBytes(data as string));
      return { uri: path };
    },
    async readFile({ path }: { path: string }) {
      const f = files.get(path);
      if (!f) throw missing(path);
      let bin = "";
      f.forEach((b) => (bin += String.fromCharCode(b)));
      return { data: btoa(bin) };
    },
    async stat({ path }: { path: string }) {
      const f = files.get(path);
      if (!f) throw missing(path);
      return { type: "file", size: f.length, mtime: 1, uri: path };
    },
    async deleteFile({ path }: { path: string }) {
      if (!files.delete(path)) throw missing(path);
    },
    async rename({ from, to }: { from: string; to: string }) {
      if (hooks.failRename) throw new Error("rename failed");
      if (hooks.refuseOverwrite && files.has(to)) throw new Error("target exists");
      const f = files.get(from);
      if (!f) throw missing(from);
      files.delete(from);
      files.set(to, f);
    },
    async mkdir() {},
    async readdir({ path }: { path: string }) {
      const prefix = path + "/";
      const seen = new Map<string, { name: string; type: string; size: number; mtime: number }>();
      for (const [p, f] of files) {
        if (!p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length);
        const slash = rest.indexOf("/");
        if (slash >= 0) seen.set(rest.slice(0, slash), { name: rest.slice(0, slash), type: "directory", size: 0, mtime: 1 });
        else seen.set(rest, { name: rest, type: "file", size: f.length, mtime: 1 });
      }
      if (seen.size === 0) throw missing(path);
      return { files: [...seen.values()] };
    },
  };
  return { files, api: api as unknown as FsApi };
}

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array | null) => (b ? new TextDecoder().decode(b) : null);

const impls: Array<[string, () => BlobStore]> = [
  ["MemoryBlobStore", () => new MemoryBlobStore()],
  ["CapacitorBlobStore(fake fs)", () => new CapacitorBlobStore({ fs: fakeFs().api })],
];

describe.each(impls)("%s contract", (_name, make) => {
  it("round-trips bytes and reports the sha256", async () => {
    const s = make();
    const data = bytes("hello frag");
    const hash = await s.write("frag/v1.frag", data);
    expect(hash).toBe(await sha256Hex(data));
    expect(text(await s.read("frag/v1.frag"))).toBe("hello frag");
  });

  it("returns null/false for missing keys", async () => {
    const s = make();
    expect(await s.read("nope")).toBeNull();
    expect(await s.stat("nope")).toBeNull();
    expect(await s.delete("nope")).toBe(false);
  });

  it("stat reports size", async () => {
    const s = make();
    await s.write("a.bin", new Uint8Array(1234));
    expect((await s.stat("a.bin"))?.size).toBe(1234);
  });

  it("overwrites an existing key", async () => {
    const s = make();
    await s.write("a", bytes("one"));
    await s.write("a", bytes("two!"));
    expect(text(await s.read("a"))).toBe("two!");
  });

  it("delete removes the key", async () => {
    const s = make();
    await s.write("a", bytes("x"));
    expect(await s.delete("a")).toBe(true);
    expect(await s.read("a")).toBeNull();
  });

  it("list filters by prefix, recurses, and sorts", async () => {
    const s = make();
    await s.write("pdf/b.pdf", bytes("b"));
    await s.write("frag/a.frag", bytes("a"));
    await s.write("frag/sub/c.frag", bytes("cc"));
    expect((await s.list()).map((e) => e.key)).toEqual(["frag/a.frag", "frag/sub/c.frag", "pdf/b.pdf"]);
    expect((await s.list("frag/")).map((e) => e.key)).toEqual(["frag/a.frag", "frag/sub/c.frag"]);
    expect(await s.list("none/")).toEqual([]);
  });

  it("rejects a write whose sha256 does not match and stores nothing", async () => {
    const s = make();
    await expect(s.write("a", bytes("x"), { sha256: "0".repeat(64) })).rejects.toBeInstanceOf(BlobIntegrityError);
    expect(await s.stat("a")).toBeNull();
  });

  it("verifies sha256 on read", async () => {
    const s = make();
    const hash = await s.write("a", bytes("x"));
    expect(text(await s.read("a", { verifySha256: hash }))).toBe("x");
    await expect(s.read("a", { verifySha256: "f".repeat(64) })).rejects.toBeInstanceOf(BlobIntegrityError);
  });

  it.each(["", "../x", "/abs", "a//b", "a/../b", "a b", "x.part"])("rejects invalid key %j", async (key) => {
    const s = make();
    await expect(s.write(key, bytes("x"))).rejects.toBeInstanceOf(InvalidBlobKeyError);
  });
});

describe("CapacitorBlobStore atomicity", () => {
  it("writes via a .part temp file that never survives a successful write", async () => {
    const { files, api } = fakeFs();
    await new CapacitorBlobStore({ fs: api }).write("a/b.bin", bytes("x"));
    expect([...files.keys()]).toEqual(["blobs/a/b.bin"]);
  });

  it("a failed rename keeps the previous value and removes the temp file", async () => {
    const ok = fakeFs();
    await new CapacitorBlobStore({ fs: ok.api }).write("k", bytes("old"));
    // Same backing map, but renames now fail.
    const failing = fakeFs({ failRename: true });
    failing.files.set("blobs/k", bytes("old"));
    const s = new CapacitorBlobStore({ fs: failing.api });
    await expect(s.write("k", bytes("new"))).rejects.toThrow();
    expect([...failing.files.keys()].filter((k) => k.endsWith(".part"))).toEqual([]);
    expect(text(await s.read("k"))).toBe("old");
  });

  it("falls back to delete+rename when the platform refuses to rename onto an existing file", async () => {
    const fs = fakeFs({ refuseOverwrite: true });
    const s = new CapacitorBlobStore({ fs: fs.api });
    await s.write("k", bytes("one"));
    await s.write("k", bytes("two"));
    expect(text(await s.read("k"))).toBe("two");
    expect([...fs.files.keys()]).toEqual(["blobs/k"]);
  });

  it("does not list in-flight temp files", async () => {
    const { files, api } = fakeFs();
    files.set("blobs/half.bin.part", bytes("partial"));
    files.set("blobs/done.bin", bytes("ok"));
    expect((await new CapacitorBlobStore({ fs: api }).list()).map((e) => e.key)).toEqual(["done.bin"]);
  });
});

describe("readRange", () => {
  const data = Uint8Array.from({ length: 300 }, (_, i) => i % 256);
  it("MemoryBlobStore slices, clamps at the end and returns null for a missing key", async () => {
    const s = new MemoryBlobStore();
    await s.write("pdf/a.pdf", data);
    expect(await s.readRange!("pdf/a.pdf", 10, 5)).toEqual(data.slice(10, 15));
    expect((await s.readRange!("pdf/a.pdf", 290, 100))!.length).toBe(10);
    expect(await s.readRange!("pdf/none.pdf", 0, 5)).toBeNull();
  });
  it("CapacitorBlobStore delegates to the native reader with the full path; absent without one", async () => {
    const calls: [string, number, number][] = [];
    const store = new CapacitorBlobStore({
      fs: fakeFs().api as unknown as FsApi,
      rangeReader: async (path, offset, length) => {
        calls.push([path, offset, length]);
        return data.slice(offset, offset + length);
      },
    });
    expect(await store.readRange!("pdf/a.pdf", 4, 3)).toEqual(data.slice(4, 7));
    expect(calls).toEqual([["blobs/pdf/a.pdf", 4, 3]]);
    await expect(store.readRange!("../x", 0, 1)).rejects.toBeInstanceOf(InvalidBlobKeyError);
    expect(new CapacitorBlobStore({ fs: fakeFs().api as unknown as FsApi }).readRange).toBeUndefined();
  });
});
