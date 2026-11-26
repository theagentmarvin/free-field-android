import { describe, expect, it } from "vitest";
import { buildCsv, type TaskTableRow } from "@ff/tasks-react";
import { memoryBackend, chunkBytes, pipeBlob, pipeText, bytesToBase64, type FileBackend } from "./exportFiles";
import { csvBatches, runExport, toReportEntries, type ExportEnv } from "./exportRun";
import { indexPendingPhotos } from "./pendingPhotos";
import { isAbort } from "./reportPdf";

const NOW = new Date(2026, 10, 25, 9, 5).getTime();
const latin1 = (b: Uint8Array): string => new TextDecoder("latin1").decode(b);

const rows = (n: number): TaskTableRow[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `t${i}`, num: i + 1, title: i === 3 ? '=cmd "quoted", title' : `Task ${i + 1}`, status: [20, 40, 65][i % 3]!, description: "d", type: "task", priority: "normal",
    assigneeName: "Ana", assigneeUid: "u1", deadline: null, buildingName: "Tower A", storeyName: "L2", createdBy: "Bo", createdByUid: "u0", createdAt: NOW, updatedAt: NOW, updatedBy: "Bo",
    checklist: [], location: null, photos: [{ storagePath: `p/t${i}/a.jpg` }], entryCount: 1, lastAction: "create",
  })) as unknown as TaskTableRow[];

function env(over: Partial<ExportEnv> = {}): ExportEnv {
  return {
    projectId: "p1",
    projectName: "Campus",
    actorName: "Ana",
    filterNote: "Status: All",
    source: { watchTask: (_p, _id, cb) => { cb(null); return () => undefined; }, watchTaskEntries: (_p, _id, cb) => { cb([]); return () => undefined; } },
    loadEntries: async () => [],
    pending: () => ({ pendingKeys: new Map(), byGuid: new Map() }),
    images: { resolveUrl: async () => null },
    ...over,
  };
}

describe("export chunking", () => {
  it("chunkBytes yields views of at most the chunk size that cover every byte", () => {
    const b = Uint8Array.from({ length: 1000 }, (_, i) => i & 255);
    const parts = chunkBytes(b, 300);
    expect(parts.map((p) => p.byteLength)).toEqual([300, 300, 300, 100]);
    expect(Uint8Array.from(parts.flatMap((p) => Array.from(p)))).toEqual(b);
    expect(chunkBytes(new Uint8Array(0))).toEqual([]);
  });

  it("base64 of chunks decodes back to the bytes (each bridge call is independent)", () => {
    const b = Uint8Array.from({ length: 70_001 }, (_, i) => (i * 7) & 255);
    const out: number[] = [];
    for (const c of chunkBytes(b, 20_000)) out.push(...Array.from(atob(bytesToBase64(c)), (ch) => ch.charCodeAt(0)));
    expect(Uint8Array.from(out)).toEqual(b);
  });

  it("pipeBlob and pipeText write bounded chunks in order", async () => {
    const sizes: number[] = [];
    let total = 0;
    let sample = -1;
    const sink = { async write(c: Uint8Array) { if (total <= 123_456 && 123_456 < total + c.byteLength) sample = c[123_456 - total]!; total += c.byteLength; sizes.push(c.byteLength); } };
    const bytes = Uint8Array.from({ length: 2_500_000 }, (_, i) => i & 255);
    await pipeBlob(new Blob([bytes as BlobPart]), sink);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(256 * 1024);
    expect(total).toBe(bytes.length);
    expect(sample).toBe(123_456 & 255);
    sizes.length = 0;
    await pipeText("é".repeat(400_000), sink);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(256 * 1024);
  });

  it("csv batches joined equal the one-shot web CSV (single header, BOM once)", () => {
    const r = rows(1234);
    const joined = [...csvBatches(r, NOW, 250)].join("");
    expect(joined).toBe(buildCsv(r, NOW));
    expect(joined.split("\r\n").length).toBe(1234 + 2);
    expect([...csvBatches([], NOW)].join("")).toBe(buildCsv([], NOW));
  });
});

describe("pending photos", () => {
  it("indexes queued photos by storage path and by entry guid; sent and killed rows are ignored", () => {
    const row = (state: string, guid: string, key: string) => ({ state, payload: { projectId: "p1", taskId: "t1", clientGuid: guid, photoRefs: [{ blobKey: key, sha256: "abcd".repeat(16), size: 1, mime: "image/jpeg" }] } }) as never;
    const idx = indexPendingPhotos([row("added", "g1", "k1"), row("sent", "g2", "k2"), row("killed", "g3", "k3")]);
    expect(idx.byGuid.size).toBe(1);
    const [path] = idx.byGuid.get("g1")!;
    expect(idx.pendingKeys.get(path!)).toBe("k1");
    const e = toReportEntries([{ action: "comment", by: "Ana", at: 1, text: "x", pending: true, clientGuid: "g1", statusFrom: null, statusTo: null, photos: [] } as never], idx);
    expect(e[0]!.photos[0]!.ref).toBe("blob:k1");
  });
});

describe("runExport", () => {
  it("CSV: one file with every row, quoting and the formula guard of the web export", async () => {
    const be = memoryBackend();
    const res = await runExport({ format: "csv", rows: rows(8), photosPerTask: 0 }, env(), be, { now: () => NOW, yieldFn: async () => undefined });
    expect(res.count).toBe(8);
    expect(res.file.name).toBe("freefield-tasks-2026-11-25.csv");
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(be.files.get(res.file.name)!);
    expect(text).toBe(buildCsv(rows(8), NOW));
    expect(text).toContain(`"'=cmd ""quoted"", title"`);
  });

  it("PDF: file exists, has pages and the task titles; progress runs to the end", async () => {
    const be = memoryBackend();
    const seen: string[] = [];
    const res = await runExport({ format: "pdf", rows: rows(40), photosPerTask: 2 }, env(), be, {
      now: () => NOW,
      yieldFn: async () => undefined,
      onProgress: (p) => seen.push(`${p.phase}:${p.done}/${p.total}`),
    });
    expect(res.file.name).toBe("freefield-task-report-2026-11-25-0905.pdf");
    expect(res.pages).toBeGreaterThan(2);
    const text = latin1(be.files.get(res.file.name)!);
    for (const i of [1, 17, 40]) expect(text).toContain(`Task ${i}`);
    expect(seen.at(-1)).toBe("build:40/40");
    // photos are not on the device in this fake: the note says so
    expect(res.notes[0]).toMatch(/not on this device/);
  });

  it("PDF cancel: the partial file is dropped and the export rejects with an abort", async () => {
    const be = memoryBackend();
    let aborted = 0;
    const wrapped: FileBackend = {
      async create(name, mime) {
        const s = await be.create(name, mime);
        return { ...s, write: s.write, close: s.close, abort: async () => { aborted++; await s.abort(); } };
      },
    };
    const ac = new AbortController();
    await expect(
      runExport({ format: "pdf", rows: rows(60), photosPerTask: 0 }, env(), wrapped, { signal: ac.signal, yieldFn: async () => undefined, onProgress: (p) => { if (p.phase === "build" && p.done === 5) ac.abort(); } }),
    ).rejects.toSatisfy(isAbort);
    expect(aborted).toBe(1);
    expect(be.files.size).toBe(0);
  });

  it("BCF: a topic per task in a valid zip, capped at 500", async () => {
    const be = memoryBackend();
    const res = await runExport({ format: "bcf21", rows: rows(6), photosPerTask: 0 }, env(), be, { now: () => NOW });
    expect(res.count).toBe(6);
    expect(res.file.name).toMatch(/bcf21\.bcfzip$/);
    // a zip lists every entry name in clear text twice (local header + central directory)
    const raw = latin1(be.files.get(res.file.name)!);
    expect(raw.startsWith("PK")).toBe(true);
    expect((raw.match(/\/markup\.bcf/g) ?? []).length).toBe(6 * 2);
    expect(raw).toContain("bcf.version");
    const big = await runExport({ format: "bcf30", rows: rows(520), photosPerTask: 0 }, env(), memoryBackend(), { now: () => NOW });
    expect(big.count).toBe(500);
    expect(big.notes.join(" ")).toMatch(/capped at 500 of 520/);
  }, 60_000);

  it("BCF cancel between tasks rejects with an abort and writes nothing", async () => {
    const be = memoryBackend();
    const ac = new AbortController();
    await expect(runExport({ format: "bcf30", rows: rows(30), photosPerTask: 0 }, env(), be, { signal: ac.signal, onProgress: (p) => { if (p.phase === "build" && p.done === 3) ac.abort(); } })).rejects.toSatisfy(isAbort);
    expect(be.files.size).toBe(0);
  });
});
