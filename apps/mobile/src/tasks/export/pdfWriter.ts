/**
 * Minimal streaming PDF writer for the task report (no dependency, offline, small memory).
 *
 * Memory model: every finished page and every embedded image is serialised straight to the sink in chunks of about
 * `flushBytes`, so the writer never holds more than one page plus one image. JPEG bytes are embedded as-is
 * (DCTDecode), which is why the report downscales photos before drawing them. Text uses the two standard Helvetica
 * faces (WinAnsi), so characters outside Latin-1 and the common typographic marks are replaced by "?".
 * Page content is left uncompressed on purpose: it stays small and text stays greppable for tests and tooling.
 */

export interface ByteSink {
  write(chunk: Uint8Array): Promise<void>;
}

export type FontId = "F1" | "F2"; // F1 = Helvetica, F2 = Helvetica-Bold

export type Rgb = readonly [number, number, number];

export const PAGE_A4 = { width: 595.28, height: 841.89 } as const;

/** Helvetica advance widths for ASCII 32..126, in 1/1000 em. */
const HELV = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584,
  584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611,
  278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722,
  500, 500, 500, 334, 260, 334, 584,
];
const HELV_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584,
  584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611,
  333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778,
  556, 556, 500, 389, 280, 389, 584,
];

const CP1252: Record<number, number> = {
  0x2013: 0x96, 0x2014: 0x97, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2026: 0x85, 0x20ac: 0x80, 0x2122: 0x99,
  0x2192: 0x2d, // arrow: closest plain mark
};

/** One WinAnsi byte per character; unmapped characters become "?". */
export function toWinAnsi(s: string): Uint8Array {
  const out: number[] = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp === 10 || cp === 13 || cp === 9) out.push(32);
    else if (cp >= 32 && cp < 127) out.push(cp);
    else if (cp >= 160 && cp <= 255) out.push(cp);
    else if (CP1252[cp] !== undefined) out.push(CP1252[cp]!);
    else out.push(63);
  }
  return Uint8Array.from(out);
}

function glyphWidth(code: number, bold: boolean): number {
  if (code >= 32 && code <= 126) return (bold ? HELV_BOLD : HELV)[code - 32]!;
  return 556;
}

/** Width of `text` in points at `size`. */
export function textWidth(text: string, size: number, bold = false): number {
  let w = 0;
  for (const code of toWinAnsi(text)) w += glyphWidth(code, bold);
  return (w * size) / 1000;
}

/** Greedy word wrap to `maxWidth` points. Words longer than a line are split. Keeps explicit line breaks. */
export function wrapText(text: string, size: number, maxWidth: number, bold = false): string[] {
  const lines: string[] = [];
  for (const para of text.split(/\r?\n/)) {
    const words = para.split(/\s+/).filter(Boolean);
    let line = "";
    for (let word of words) {
      while (textWidth(word, size, bold) > maxWidth && word.length > 1) {
        let cut = word.length - 1;
        while (cut > 1 && textWidth(word.slice(0, cut), size, bold) > maxWidth) cut--;
        if (line) {
          lines.push(line);
          line = "";
        }
        lines.push(word.slice(0, cut));
        word = word.slice(cut);
      }
      const next = line ? `${line} ${word}` : word;
      if (line && textWidth(next, size, bold) > maxWidth) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    lines.push(line);
  }
  return lines;
}

/** Truncate with an ellipsis ("...") so the text fits `maxWidth`. */
export function fitText(text: string, size: number, maxWidth: number, bold = false): string {
  if (textWidth(text, size, bold) <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && textWidth(`${t}...`, size, bold) > maxWidth) t = t.slice(0, -1);
  return `${t}...`;
}

const enc = new TextEncoder();
const ascii = (s: string): Uint8Array => enc.encode(s);
const num = (n: number): string => (Math.round(n * 100) / 100).toString();
const rgbOps = (c: Rgb): string => `${num(c[0])} ${num(c[1])} ${num(c[2])}`;

export interface JpegImage {
  bytes: Uint8Array;
  width: number;
  height: number;
}

export interface PdfInfo {
  title?: string;
  author?: string;
  creator?: string;
}

const OBJ_CATALOG = 1;
const OBJ_PAGES = 2;
const OBJ_F1 = 3;
const OBJ_F2 = 4;
const OBJ_INFO = 5;
const FIRST_FREE = 6;

/**
 * Usage: `const pdf = new PdfWriter(sink); await pdf.begin(); const p = pdf.page(); p.text(...); await pdf.endPage(); ... await pdf.finish();`
 * Page coordinates are points with the origin at the TOP-left (converted internally).
 */
export class PdfWriter {
  private readonly parts: Uint8Array[] = [];
  private buffered = 0;
  private offset = 0;
  private nextObj = FIRST_FREE;
  private readonly xref = new Map<number, number>();
  private readonly pageObjs: number[] = [];
  private cur: PdfPage | null = null;
  /** peak bytes held in memory before a flush (for tests) */
  maxBuffered = 0;

  constructor(
    private readonly sink: ByteSink,
    private readonly info: PdfInfo = {},
    private readonly flushBytes = 256 * 1024,
  ) {}

  get pageCount(): number {
    return this.pageObjs.length;
  }

  get bytesWritten(): number {
    return this.offset;
  }

  private async put(b: Uint8Array): Promise<void> {
    this.parts.push(b);
    this.buffered += b.byteLength;
    this.offset += b.byteLength;
    if (this.buffered > this.maxBuffered) this.maxBuffered = this.buffered;
    if (this.buffered >= this.flushBytes) await this.flush();
  }

  private async flush(): Promise<void> {
    if (this.parts.length === 0) return;
    const out = new Uint8Array(this.buffered);
    let o = 0;
    for (const p of this.parts) {
      out.set(p, o);
      o += p.byteLength;
    }
    this.parts.length = 0;
    this.buffered = 0;
    await this.sink.write(out);
  }

  private async obj(id: number, body: string | Uint8Array[]): Promise<void> {
    this.xref.set(id, this.offset);
    if (typeof body === "string") {
      await this.put(ascii(`${id} 0 obj\n${body}\nendobj\n`));
      return;
    }
    await this.put(ascii(`${id} 0 obj\n`));
    for (const p of body) await this.put(p);
    await this.put(ascii("\nendobj\n"));
  }

  async begin(): Promise<void> {
    await this.put(ascii("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n"));
    await this.obj(OBJ_F1, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
    await this.obj(OBJ_F2, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  }

  /** Start a new page; the previous one must have been ended. */
  page(size: { width: number; height: number } = PAGE_A4): PdfPage {
    if (this.cur) throw new Error("endPage() the current page first");
    this.cur = new PdfPage(this, size);
    return this.cur;
  }

  /** Register an image object now (written immediately) and return its id for `PdfPage.drawImage`. */
  async addImage(img: JpegImage): Promise<number> {
    const id = this.nextObj++;
    await this.obj(id, [
      ascii(`<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.bytes.byteLength} >>\nstream\n`),
      img.bytes,
      ascii("\nendstream"),
    ]);
    return id;
  }

  async endPage(): Promise<void> {
    const p = this.cur;
    if (!p) throw new Error("no open page");
    this.cur = null;
    const content = ascii(p.ops.join("\n"));
    const contentId = this.nextObj++;
    await this.obj(contentId, [ascii(`<< /Length ${content.byteLength} >>\nstream\n`), content, ascii("\nendstream")]);
    const pageId = this.nextObj++;
    const xo = [...p.images].map(([name, id]) => `/${name} ${id} 0 R`).join(" ");
    await this.obj(
      pageId,
      `<< /Type /Page /Parent ${OBJ_PAGES} 0 R /MediaBox [0 0 ${num(p.size.width)} ${num(p.size.height)}] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${OBJ_F1} 0 R /F2 ${OBJ_F2} 0 R >>${xo ? ` /XObject << ${xo} >>` : ""} >> >>`,
    );
    this.pageObjs.push(pageId);
  }

  async finish(): Promise<{ pages: number; bytes: number }> {
    if (this.cur) await this.endPage();
    const esc = (s: string) => Array.from(toWinAnsi(s)).map((c) => (c === 40 || c === 41 || c === 92 ? `\\${String.fromCharCode(c)}` : String.fromCharCode(c))).join("");
    await this.obj(OBJ_PAGES, `<< /Type /Pages /Count ${this.pageObjs.length} /Kids [${this.pageObjs.map((i) => `${i} 0 R`).join(" ")}] >>`);
    await this.obj(OBJ_CATALOG, `<< /Type /Catalog /Pages ${OBJ_PAGES} 0 R >>`);
    const fields = [`/Producer (FreeField Field)`];
    if (this.info.title) fields.push(`/Title (${esc(this.info.title)})`);
    if (this.info.author) fields.push(`/Author (${esc(this.info.author)})`);
    if (this.info.creator) fields.push(`/Creator (${esc(this.info.creator)})`);
    await this.obj(OBJ_INFO, `<< ${fields.join(" ")} >>`);
    const xrefAt = this.offset;
    const size = this.nextObj;
    let x = `xref\n0 ${size}\n0000000000 65535 f \n`;
    for (let i = 1; i < size; i++) x += `${String(this.xref.get(i) ?? 0).padStart(10, "0")} 00000 n \n`;
    x += `trailer\n<< /Size ${size} /Root ${OBJ_CATALOG} 0 R /Info ${OBJ_INFO} 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
    await this.put(ascii(x));
    await this.flush();
    return { pages: this.pageObjs.length, bytes: this.offset };
  }
}

export class PdfPage {
  readonly ops: string[] = [];
  readonly images = new Map<string, number>();
  constructor(
    private readonly doc: PdfWriter,
    readonly size: { width: number; height: number },
  ) {
    void this.doc;
  }

  private y(top: number): number {
    return this.size.height - top;
  }

  /** Filled rectangle; (x, top) is the top-left corner. */
  rect(x: number, top: number, w: number, h: number, fill: Rgb): void {
    this.ops.push(`${rgbOps(fill)} rg ${num(x)} ${num(this.y(top + h))} ${num(w)} ${num(h)} re f`);
  }

  strokeRect(x: number, top: number, w: number, h: number, stroke: Rgb, lineWidth = 0.75): void {
    this.ops.push(`${rgbOps(stroke)} RG ${num(lineWidth)} w ${num(x)} ${num(this.y(top + h))} ${num(w)} ${num(h)} re S`);
  }

  line(x1: number, top1: number, x2: number, top2: number, stroke: Rgb, lineWidth = 0.75): void {
    this.ops.push(`${rgbOps(stroke)} RG ${num(lineWidth)} w ${num(x1)} ${num(this.y(top1))} m ${num(x2)} ${num(this.y(top2))} l S`);
  }

  /** Text with its baseline at `top`. */
  text(x: number, top: number, s: string, size: number, color: Rgb = [0, 0, 0], font: FontId = "F1"): void {
    const lit = Array.from(toWinAnsi(s))
      .map((c) => (c === 40 || c === 41 || c === 92 ? `\\${String.fromCharCode(c)}` : c < 127 && c >= 32 ? String.fromCharCode(c) : `\\${c.toString(8).padStart(3, "0")}`))
      .join("");
    this.ops.push(`BT ${rgbOps(color)} rg /${font} ${num(size)} Tf ${num(x)} ${num(this.y(top))} Td (${lit}) Tj ET`);
  }

  /** Draw an image registered with `PdfWriter.addImage`, scaled into the box. */
  drawImage(imageId: number, x: number, top: number, w: number, h: number): void {
    const name = `Im${imageId}`;
    this.images.set(name, imageId);
    this.ops.push(`q ${num(w)} 0 0 ${num(h)} ${num(x)} ${num(this.y(top + h))} cm /${name} Do Q`);
  }
}
