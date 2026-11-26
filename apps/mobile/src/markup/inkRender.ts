import { encodeJpegUnder } from "./encode";
import { HIGHLIGHT_OPACITY, markupPath, textBox, TEXT_LINE_HEIGHT, type PageSize } from "./geometry";
import type { Ink } from "./ink";

/** Draw one item into a canvas context whose units are picture pixels (`page` = the picture size in px). */
export function drawInk(ctx: CanvasRenderingContext2D, ink: Ink, page: PageSize): void {
  ctx.save();
  const lw = Math.max(1.5, ink.strokeWidth * page.width);
  ctx.strokeStyle = ink.color;
  ctx.fillStyle = ink.color;
  ctx.lineWidth = lw;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  if (ink.kind === "text") {
    const b = textBox(ink.shape, page);
    const px = (ink.shape.size ?? 0.03) * page.width;
    ctx.font = `600 ${px}px sans-serif`;
    ctx.textBaseline = "top";
    ctx.lineWidth = px / 6;
    ctx.strokeStyle = "#ffffff";
    (ink.shape.text ?? "").split("\n").forEach((line, i) => {
      const y = b.y + i * px * TEXT_LINE_HEIGHT;
      ctx.strokeText(line, b.x, y);
      ctx.fillText(line, b.x, y);
    });
  } else {
    const d = markupPath(ink.kind, ink.shape, ink.strokeWidth, page);
    if (d) {
      if (ink.kind === "highlight") {
        ctx.globalAlpha = HIGHLIGHT_OPACITY;
        ctx.globalCompositeOperation = "multiply";
        ctx.lineCap = "butt";
      }
      ctx.stroke(new Path2D(d));
    }
  }
  ctx.restore();
}

export interface Flattened {
  blob: Blob;
  width: number;
  height: number;
}

/** The picture with every drawing burned in, as a JPEG under the size target. */
export async function flattenInk(base: Blob, items: readonly Ink[]): Promise<Flattened> {
  const bmp = await createImageBitmap(base, { imageOrientation: "from-image" });
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d canvas");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, bmp.width, bmp.height);
    ctx.drawImage(bmp, 0, 0);
    const page = { width: bmp.width, height: bmp.height };
    for (const ink of items) drawInk(ctx, ink, page);
    const blob = await encodeJpegUnder(canvas);
    const out = { blob, width: bmp.width, height: bmp.height };
    canvas.width = 0;
    canvas.height = 0;
    return out;
  } finally {
    bmp.close?.();
  }
}
