import { describe, expect, it } from "vitest";
import { fitText, PdfWriter, textWidth, toWinAnsi, wrapText, type ByteSink } from "./pdfWriter";

function collector(): ByteSink & { chunks: Uint8Array[]; bytes(): Uint8Array } {
  const chunks: Uint8Array[] = [];
  return {
    chunks,
    async write(c) {
      chunks.push(c.slice());
    },
    bytes() {
      const n = chunks.reduce((a, c) => a + c.byteLength, 0);
      const out = new Uint8Array(n);
      let o = 0;
      for (const c of chunks) {
        out.set(c, o);
        o += c.byteLength;
      }
      return out;
    },
  };
}
const latin1 = (b: Uint8Array): string => new TextDecoder("latin1").decode(b);

const JPEG = (n: number): Uint8Array => Uint8Array.from({ length: n }, (_, i) => (i * 31) & 255);

describe("pdf writer", () => {
  it("writes a structurally valid file: header, N pages, xref offsets that point at their objects", async () => {
    const sink = collector();
    const pdf = new PdfWriter(sink, { title: "T" });
    await pdf.begin();
    for (let i = 0; i < 3; i++) {
      const p = pdf.page();
      p.text(40, 60, `Page ${i + 1} (title) \\ ok`, 12, [0, 0, 0], "F2");
      p.rect(10, 10, 50, 20, [1, 0, 0]);
      await pdf.endPage();
    }
    const res = await pdf.finish();
    expect(res.pages).toBe(3);
    const text = latin1(sink.bytes());
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
    expect((text.match(/\/Type \/Page /g) ?? []).length).toBe(3);
    expect(text).toContain("/Count 3");
    // every xref entry points at "<n> 0 obj"
    const xrefAt = Number(/startxref\n(\d+)/.exec(text)![1]);
    expect(text.slice(xrefAt, xrefAt + 4)).toBe("xref");
    const lines = text.slice(xrefAt).split("\n");
    const size = Number(/^0 (\d+)$/.exec(lines[1]!)![1]);
    for (let n = 1; n < size; n++) {
      const off = Number(lines[2 + n]!.slice(0, 10));
      expect(text.slice(off, off + `${n} 0 obj`.length)).toBe(`${n} 0 obj`);
    }
    // text is escaped and stays greppable
    expect(text).toContain("(Page 1 \\(title\\) \\\\ ok) Tj");
  });

  it("embeds JPEG bytes untouched as DCTDecode image objects and references them from the page", async () => {
    const sink = collector();
    const pdf = new PdfWriter(sink);
    await pdf.begin();
    const jpeg = JPEG(500);
    const id = await pdf.addImage({ bytes: jpeg, width: 40, height: 30 });
    const p = pdf.page();
    p.drawImage(id, 10, 10, 100, 75);
    await pdf.endPage();
    await pdf.finish();
    const all = sink.bytes();
    const text = latin1(all);
    expect(text).toContain("/Filter /DCTDecode");
    expect(text).toContain(`/XObject << /Im${id} ${id} 0 R >>`);
    // the exact bytes are in the file
    const marker = latin1(jpeg.subarray(0, 40));
    expect(text.indexOf(marker)).toBeGreaterThan(0);
  });

  it("flushes in bounded chunks: memory stays near one page plus one image however many pages are written", async () => {
    const sink = collector();
    const pdf = new PdfWriter(sink, {}, 64 * 1024);
    await pdf.begin();
    for (let i = 0; i < 200; i++) {
      const id = await pdf.addImage({ bytes: JPEG(20_000), width: 100, height: 100 });
      const p = pdf.page();
      p.drawImage(id, 0, 0, 50, 50);
      await pdf.endPage();
    }
    await pdf.finish();
    expect(pdf.bytesWritten).toBeGreaterThan(4_000_000);
    expect(sink.chunks.length).toBeGreaterThan(50);
    // a flush happens as soon as 64 KB are pending, so at most one image object (20 KB) overshoots the limit
    expect(pdf.maxBuffered).toBeLessThan(64 * 1024 + 30_000);
  });

  it("maps typographic characters to WinAnsi and unknown ones to '?'", () => {
    const b = toWinAnsi("a–b “q” é 中");
    expect(Array.from(b)).toEqual([97, 0x96, 98, 32, 0x93, 113, 0x94, 32, 0xe9, 32, 63]);
  });

  it("measures and wraps text", () => {
    expect(textWidth("iiii", 10)).toBeLessThan(textWidth("WWWW", 10));
    const lines = wrapText("one two three four five six seven eight nine ten", 10, 80);
    expect(lines.length).toBeGreaterThan(2);
    for (const l of lines) expect(textWidth(l, 10)).toBeLessThanOrEqual(80);
    expect(wrapText("a\nb", 10, 100)).toEqual(["a", "b"]);
    // an unbreakable word longer than the line is split instead of overflowing
    for (const l of wrapText("W".repeat(60), 10, 50)) expect(textWidth(l, 10)).toBeLessThanOrEqual(50);
    expect(textWidth(fitText("A very long title that cannot fit", 10, 60), 10)).toBeLessThanOrEqual(60);
  });

  it("refuses two open pages", async () => {
    const pdf = new PdfWriter(collector());
    await pdf.begin();
    pdf.page();
    expect(() => pdf.page()).toThrow();
  });
});
