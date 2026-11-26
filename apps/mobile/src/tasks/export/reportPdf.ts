import { statusAccent } from "@ff/tasks-react";
import { fitText, PAGE_A4, PdfWriter, textWidth, wrapText, type ByteSink, type JpegImage, type PdfPage, type Rgb } from "./pdfWriter";
import type { ImageRef, ReportBlock, ReportMeta } from "./reportModel";

/**
 * Lays the report blocks out on A4 pages: a title page (project, buildings, filters, date, status counts), then one block per
 * task in view order. Images are pulled through `loadImage` one at a time, drawn, and dropped, so memory stays flat however many
 * tasks or photos the report has. Cancelling (AbortSignal) stops between tasks and between images.
 */

export type ImageLoader = (ref: ImageRef, maxSide: number) => Promise<JpegImage | null>;

export interface RenderReportOptions {
  signal?: AbortSignal;
  onProgress?(done: number, total: number): void;
  /** Largest edge, in pixels, the loader should downscale photos to. */
  photoMaxSide?: number;
  /** Total image bytes the report may embed; further images are left out. */
  maxImageBytes?: number;
  /** yield to the event loop (UI stays responsive); tests pass a no-op */
  yieldFn?: () => Promise<void>;
  /** called after each finished page (tests, memory probes) */
  onPage?(pages: number): void;
}

export interface RenderReportResult {
  pages: number;
  bytes: number;
  tasks: number;
  imagesDrawn: number;
  /** images that could not be loaded (not on the device yet) */
  imagesMissing: number;
  /** images left out because the size budget was reached */
  imagesOverBudget: number;
}

const M = { left: 40, right: 40, top: 44, bottom: 52 };
const W = PAGE_A4.width - M.left - M.right;
const INK: Rgb = [0.067, 0.094, 0.153];
const MUTED: Rgb = [0.42, 0.45, 0.5];
const LINE: Rgb = [0.9, 0.91, 0.92];
const BAND: Rgb = [0.059, 0.09, 0.165];
const CHIP_BG: Rgb = [0.933, 0.949, 1];
const CHIP_INK: Rgb = [0.216, 0.188, 0.639];
const WHITE: Rgb = [1, 1, 1];
const IMG_BG: Rgb = [0.95, 0.96, 0.97];

function hex(c: string): Rgb {
  const m = /^#?([0-9a-f]{6})$/i.exec(c.trim());
  if (!m) return [0.48, 0.51, 0.55];
  const n = parseInt(m[1]!, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function abortError(): Error {
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
}

export const isAbort = (e: unknown): boolean => (e as Error)?.name === "AbortError";

export async function renderReport(
  sink: ByteSink,
  blocks: AsyncIterable<ReportBlock> | Iterable<ReportBlock>,
  meta: ReportMeta,
  loadImage: ImageLoader,
  opts: RenderReportOptions = {},
): Promise<RenderReportResult> {
  const pdf = new PdfWriter(sink, { title: `Task report - ${meta.projectName}`, author: meta.printedBy || undefined, creator: "FreeField Field" });
  const yieldFn = opts.yieldFn ?? (() => new Promise<void>((r) => setTimeout(r, 0)));
  const photoSide = opts.photoMaxSide ?? 900;
  const budget = opts.maxImageBytes ?? 120 * 1024 * 1024;
  let imageBytes = 0;
  const stats = { drawn: 0, missing: 0, over: 0 };
  const check = (): void => {
    if (opts.signal?.aborted) throw abortError();
  };

  await pdf.begin();
  let page: PdfPage = pdf.page();
  let top = M.top;
  let pageNo = 1;

  const footer = (p: PdfPage, n: number): void => {
    p.line(M.left, PAGE_A4.height - 38, PAGE_A4.width - M.right, PAGE_A4.height - 38, LINE);
    p.text(M.left, PAGE_A4.height - 26, fitText(`FreeField task report - ${meta.projectName} - ${meta.printedAt}`, 8, W - 60), 8, MUTED);
    const label = `Page ${n}`;
    p.text(PAGE_A4.width - M.right - textWidth(label, 8), PAGE_A4.height - 26, label, 8, MUTED);
  };
  const newPage = async (): Promise<void> => {
    footer(page, pageNo);
    await pdf.endPage();
    opts.onPage?.(pdf.pageCount);
    page = pdf.page();
    pageNo += 1;
    top = M.top;
  };
  const room = (): number => PAGE_A4.height - M.bottom - top;
  const ensure = async (h: number): Promise<void> => {
    if (h > room() && top > M.top) await newPage();
  };

  // ---- title page ----
  page.rect(M.left, top, W, 34, BAND);
  page.text(M.left + 12, top + 22, "FREE FIELD", 13, WHITE, "F2");
  page.text(M.left + 12 + textWidth("FREE FIELD ", 13, true), top + 22, "Task report", 9, [0.8, 0.84, 0.89]);
  const when = fitText(meta.printedAt + (meta.printedBy ? ` - ${meta.printedBy}` : ""), 9, W * 0.5);
  page.text(M.left + W - 12 - textWidth(when, 9), top + 21, when, 9, [0.8, 0.84, 0.89]);
  top += 34 + 26;
  for (const line of wrapText(meta.projectName, 22, W, true)) {
    page.text(M.left, top, line, 22, INK, "F2");
    top += 26;
  }
  top += 4;
  const kv = (k: string, v: string): void => {
    page.text(M.left, top, k.toUpperCase(), 8, MUTED, "F2");
    top += 12;
    for (const line of wrapText(v, 11, W)) {
      page.text(M.left, top, line, 11, INK);
      top += 14;
    }
    top += 8;
  };
  kv("Tasks", `${meta.taskCount} task${meta.taskCount === 1 ? "" : "s"}${meta.totalInView !== undefined && meta.totalInView > meta.taskCount ? ` (first ${meta.taskCount} of ${meta.totalInView} in this view)` : ""}`);
  if (meta.buildings.length) kv("Building", meta.buildings.join(", "));
  kv("Filters", meta.filterNote);
  kv("Generated", meta.printedAt + (meta.printedBy ? ` by ${meta.printedBy}` : ""));
  if (meta.statusCounts.length) kv("By status", meta.statusCounts.map((s) => `${s.label}: ${s.count}`).join("   "));
  await newPage();

  // ---- image drawing ----
  const drawBoxImage = async (ref: ImageRef, x: number, y: number, w: number, h: number): Promise<void> => {
    page.rect(x, y, w, h, IMG_BG);
    check();
    if (imageBytes >= budget) {
      stats.over += 1;
      return;
    }
    let img: JpegImage | null = null;
    try {
      img = await loadImage(ref, photoSide);
    } catch (e) {
      if (isAbort(e)) throw e;
      img = null;
    }
    if (!img) {
      stats.missing += 1;
      page.text(x + 6, y + h / 2 + 3, "Image not on device", 7, MUTED);
      return;
    }
    if (imageBytes + img.bytes.byteLength > budget) {
      stats.over += 1;
      return;
    }
    imageBytes += img.bytes.byteLength;
    const s = Math.min(w / img.width, h / img.height);
    const dw = img.width * s;
    const dh = img.height * s;
    const id = await pdf.addImage(img);
    page.drawImage(id, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
    stats.drawn += 1;
  };

  const drawImageRow = async (items: { ref: ImageRef; label?: string | null }[], perRow: number, boxH: number): Promise<void> => {
    const gap = 8;
    const boxW = (W - gap * (perRow - 1)) / perRow;
    for (let i = 0; i < items.length; i += perRow) {
      const row = items.slice(i, i + perRow);
      const labelH = row.some((r) => r.label) ? 11 : 0;
      await ensure(boxH + labelH + 6);
      for (let j = 0; j < row.length; j++) {
        const x = M.left + j * (boxW + gap);
        await drawBoxImage(row[j]!.ref, x, top, boxW, boxH);
        if (row[j]!.label) page.text(x, top + boxH + 9, fitText(row[j]!.label!, 7, boxW), 7, MUTED);
      }
      top += boxH + labelH + 6;
    }
  };

  // ---- one block per task ----
  let done = 0;
  let total = meta.taskCount;
  for await (const b of blocks as AsyncIterable<ReportBlock>) {
    check();
    total = Math.max(total, done + 1);
    await ensure(150);
    // title row: number chip, title, status pill
    const accent = statusAccent(b.status);
    const pillW = textWidth(b.statusLabel, 8, true) + 18;
    const numW = textWidth(b.num, 9, true) + 14;
    const titleW = W - numW - pillW - 20;
    const titleLines = wrapText(b.title, 13, titleW, true);
    const headH = Math.max(22, titleLines.length * 16 + 4);
    await ensure(headH + 60);
    page.rect(M.left, top, W, 0.8, LINE);
    top += 10;
    page.rect(M.left, top, numW, 18, CHIP_BG);
    page.text(M.left + 7, top + 13, b.num, 9, CHIP_INK, "F2");
    titleLines.forEach((l, i) => page.text(M.left + numW + 10, top + 13 + i * 16, l, 13, INK, "F2"));
    page.rect(M.left + W - pillW, top, pillW, 17, hex(accent.bg));
    page.text(M.left + W - pillW + 9, top + 12, b.statusLabel, 8, hex(accent.ink), "F2");
    top += headH + 6;

    if (b.description) {
      for (const line of wrapText(b.description, 10, W)) {
        await ensure(14);
        page.text(M.left, top + 10, line, 10, [0.22, 0.25, 0.32]);
        top += 13;
      }
      top += 4;
    }

    // field grid, 3 columns
    const colW = (W - 24) / 3;
    for (let i = 0; i < b.fields.length; i += 3) {
      const row = b.fields.slice(i, i + 3);
      const wrapped = row.map((f) => wrapText(f.v, 9.5, colW));
      const h = 11 + Math.max(...wrapped.map((w) => w.length)) * 12 + 4;
      await ensure(h);
      row.forEach((f, j) => {
        const x = M.left + j * (colW + 12);
        page.text(x, top + 8, f.k.toUpperCase(), 7, MUTED, "F2");
        const col: Rgb = f.flag === "late" ? [0.86, 0.15, 0.15] : f.flag === "soon" ? [0.7, 0.33, 0.04] : INK;
        wrapped[j]!.forEach((l, k) => page.text(x, top + 20 + k * 12, l, 9.5, col));
      });
      top += h;
    }

    if (b.checklist.length > 0) {
      await ensure(20);
      page.text(M.left, top + 10, "CHECKLIST", 7, MUTED, "F2");
      top += 14;
      for (const c of b.checklist.slice(0, 20)) {
        await ensure(13);
        page.text(M.left + 4, top + 9, fitText(`${c.done ? "[x]" : "[ ]"} ${c.text}`, 9, W - 8), 9, c.done ? MUTED : INK);
        top += 12;
      }
      if (b.checklist.length > 20) {
        page.text(M.left + 4, top + 9, `... ${b.checklist.length - 20} more items`, 8, MUTED);
        top += 12;
      }
    }

    top += 4;
    if (b.locationImages.length > 0) await drawImageRow(b.locationImages.map((l) => ({ ref: l.ref, label: l.label })), 2, 110);
    if (b.photos.length > 0) await drawImageRow(b.photos.map((p) => ({ ref: p.ref, label: p.caption })), 4, 96);
    if (b.morePhotos > 0) {
      await ensure(12);
      page.text(M.left, top + 8, `+ ${b.morePhotos} more photo${b.morePhotos === 1 ? "" : "s"} on the task`, 8, MUTED);
      top += 12;
    }

    if (b.entries.length > 0) {
      await ensure(30);
      page.text(M.left, top + 10, "TIMELINE", 7, MUTED, "F2");
      top += 14;
      for (const e of b.entries) {
        const head = `${e.title}${e.transition ? `  (${e.transition})` : ""}`;
        const lines = e.text ? wrapText(e.text, 9.5, W - 16) : [];
        await ensure(26 + Math.min(lines.length, 3) * 12);
        page.rect(M.left, top + 3, 4, 4, [0.42, 0.45, 0.5]);
        page.text(M.left + 10, top + 8, fitText(head, 9.5, W - 16, true), 9.5, INK, "F2");
        top += 13;
        page.text(M.left + 10, top + 7, fitText(`${e.who} - ${e.when}${e.state ? ` - ${e.state}` : ""}`, 8, W - 16), 8, MUTED);
        top += 11;
        for (const l of lines) {
          await ensure(12);
          page.text(M.left + 10, top + 8, l, 9.5, [0.22, 0.25, 0.32]);
          top += 12;
        }
        if (e.photos.length > 0) await drawImageRow(e.photos.map((p) => ({ ref: p.ref, label: p.caption })), 3, 70);
        top += 3;
      }
    }

    top += 10;
    done += 1;
    opts.onProgress?.(done, total);
    await yieldFn();
  }
  if (done === 0) {
    page.text(M.left, top + 10, "No tasks in this view.", 11, MUTED);
  }
  footer(page, pageNo);
  await pdf.endPage();
  opts.onPage?.(pdf.pageCount);
  const res = await pdf.finish();
  return { pages: res.pages, bytes: res.bytes, tasks: done, imagesDrawn: stats.drawn, imagesMissing: stats.missing, imagesOverBudget: stats.over };
}
