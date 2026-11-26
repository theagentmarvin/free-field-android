import { describe, expect, it } from "vitest";
import type { ByteSink, JpegImage } from "./pdfWriter";
import { buildReportBlock, buildReportMeta, type ReportBlock } from "./reportModel";
import { isAbort, renderReport } from "./reportPdf";

const NOW = new Date(2026, 10, 25, 12, 0).getTime();
const latin1 = (b: Uint8Array): string => new TextDecoder("latin1").decode(b);

function sinkOf() {
  const chunks: Uint8Array[] = [];
  const sink: ByteSink = { async write(c) { chunks.push(c.slice()); } };
  return {
    sink,
    chunks,
    text: () => latin1(Uint8Array.from(chunks.flatMap((c) => Array.from(c)))),
    size: () => chunks.reduce((n, c) => n + c.byteLength, 0),
  };
}

const jpeg = (n = 4000): JpegImage => ({ bytes: new Uint8Array(n).fill(7), width: 800, height: 600 });
const noYield = async () => undefined;

function blocks(n: number, photos = 2): ReportBlock[] {
  return Array.from({ length: n }, (_, i) =>
    buildReportBlock(
      {
        row: { id: `t${i}`, num: i + 1, title: `Task number ${i + 1}: check the slab`, status: i % 2 ? 40 : 20, description: "Long description ".repeat(30), type: "task", priority: null, assigneeName: "Ana", deadline: null, buildingName: "Tower A", storeyName: "L2", createdBy: "Bo", createdAt: NOW, updatedAt: NOW, checklist: [], location: null, photos: [] } as never,
        photos: Array.from({ length: photos }, (_, k) => ({ ref: `p${i}-${k}` })),
        entries: [
          { action: "create", by: "Bo", at: NOW, statusFrom: null, statusTo: 20, text: "x", photos: [] },
          { action: "comment", by: "Ana", at: NOW, statusFrom: null, statusTo: null, text: "Comment on the slab\nsecond line", photos: [{ ref: `c${i}` }] },
        ],
      },
      { now: NOW },
    ),
  );
}
const meta = (n: number) => buildReportMeta(blocks(n).map((b) => ({ status: b.status })) as never, { projectName: "Campus", filterNote: "Status: All", printedBy: "Ana", now: NOW });

describe("renderReport", () => {
  it("title page plus one block per task: page count, task titles and project text are in the file", async () => {
    const out = sinkOf();
    const res = await renderReport(out.sink, blocks(12), meta(12), async () => jpeg(), { yieldFn: noYield });
    const text = out.text();
    expect(res.tasks).toBe(12);
    expect(res.pages).toBeGreaterThan(2);
    expect((text.match(/\/Type \/Page /g) ?? []).length).toBe(res.pages);
    expect(text).toContain("Task number 1: check the slab");
    expect(text).toContain("Task number 12: check the slab");
    expect(text).toContain("(Campus)");
    expect(text).toContain("Status: All");
    expect(text).toContain("T007");
    expect(text).toContain("Comment on the slab");
    expect(res.imagesDrawn).toBe(12 * 3);
  });

  it("reports progress per task and never holds more than a page plus an image in memory (500 tasks)", async () => {
    const out = sinkOf();
    const seen: number[] = [];
    let maxChunk = 0;
    const sink: ByteSink = { async write(c) { maxChunk = Math.max(maxChunk, c.byteLength); await out.sink.write(c); } };
    const res = await renderReport(sink, blocks(500, 4), meta(500), async () => jpeg(30_000), { yieldFn: noYield, onProgress: (d) => seen.push(d), maxImageBytes: 1e9 });
    expect(res.tasks).toBe(500);
    expect(seen.length).toBe(500);
    expect(seen[499]).toBe(500);
    expect(res.pages).toBeGreaterThan(300);
    // the sink only ever receives bounded chunks (256 KB flush plus at most one image object)
    expect(maxChunk).toBeLessThan(256 * 1024 + 40_000);
    expect(out.size()).toBeGreaterThan(500 * 4 * 30_000);
  });

  it("downscaled photos are requested at the report size, one at a time", async () => {
    let active = 0;
    let peak = 0;
    const sides = new Set<number>();
    await renderReport(sinkOf().sink, blocks(5), meta(5), async (_ref, side) => {
      sides.add(side);
      active++;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active--;
      return jpeg();
    }, { yieldFn: noYield, photoMaxSide: 640 });
    expect([...sides]).toEqual([640]);
    expect(peak).toBe(1);
  });

  it("missing images leave a placeholder and are counted; the size budget leaves images out", async () => {
    const a = sinkOf();
    const r1 = await renderReport(a.sink, blocks(3), meta(3), async () => null, { yieldFn: noYield });
    expect(r1.imagesMissing).toBe(9);
    expect(a.text()).toContain("Image not on device");
    const b = sinkOf();
    const r2 = await renderReport(b.sink, blocks(10), meta(10), async () => jpeg(10_000), { yieldFn: noYield, maxImageBytes: 50_000 });
    expect(r2.imagesDrawn).toBe(5);
    expect(r2.imagesOverBudget).toBe(25);
  });

  it("cancelling stops between tasks with an AbortError", async () => {
    const ac = new AbortController();
    const out = sinkOf();
    let done = 0;
    await expect(
      renderReport(out.sink, blocks(100), meta(100), async () => jpeg(), {
        signal: ac.signal,
        yieldFn: noYield,
        onProgress: (d) => {
          done = d;
          if (d === 7) ac.abort();
        },
      }),
    ).rejects.toSatisfy(isAbort);
    expect(done).toBe(7);
  });

  it("an empty view still produces a one-page title document", async () => {
    const out = sinkOf();
    const res = await renderReport(out.sink, [], meta(0), async () => null, { yieldFn: noYield });
    expect(res.tasks).toBe(0);
    expect(res.pages).toBeGreaterThanOrEqual(2);
    expect(out.text()).toContain("No tasks in this view.");
  });
});
