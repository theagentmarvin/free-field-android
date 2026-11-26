import { arrowHead, type Shape } from "./model";

/** The subset of the 2D context the renderer needs (fakeable in tests). */
export interface Ctx2D {
  save(): void;
  restore(): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  stroke(): void;
  fillText(text: string, x: number, y: number): void;
  strokeText(text: string, x: number, y: number): void;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  fillStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
  font: string;
  textBaseline: CanvasTextBaseline;
}

/**
 * Draw shapes onto a context of `width x height` pixels. Stroke widths and
 * text size are fractions of the longer edge, so a preview and a full-size
 * flatten look identical.
 */
export function drawShapes(ctx: Ctx2D, shapes: readonly Shape[], width: number, height: number): void {
  const edge = Math.max(width, height);
  const aspect = width / height;
  const px = (p: [number, number]): [number, number] => [p[0] * width, p[1] * height];
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const s of shapes) {
    if (s.kind === "text") {
      const size = Math.max(10, s.size * edge);
      ctx.font = `600 ${size}px system-ui, sans-serif`;
      ctx.textBaseline = "top";
      const [x, y] = px(s.at);
      // dark outline keeps text readable on any photo
      ctx.lineWidth = Math.max(2, size / 8);
      ctx.strokeStyle = s.color === "#000000" ? "#ffffff" : "#000000";
      s.text.split("\n").forEach((line, i) => ctx.strokeText(line, x, y + i * size * 1.15));
      ctx.fillStyle = s.color;
      s.text.split("\n").forEach((line, i) => ctx.fillText(line, x, y + i * size * 1.15));
      continue;
    }
    ctx.strokeStyle = s.color;
    ctx.lineWidth = Math.max(1, s.width * edge);
    ctx.beginPath();
    if (s.kind === "pen") {
      const [first, ...rest] = s.points;
      if (!first) continue;
      const [x0, y0] = px(first);
      ctx.moveTo(x0, y0);
      if (rest.length === 0) ctx.lineTo(x0 + 0.01, y0); // a dot
      for (const p of rest) ctx.lineTo(...px(p));
      ctx.stroke();
    } else if (s.kind === "rect") {
      const [x0, y0] = px(s.from);
      const [x1, y1] = px(s.to);
      ctx.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
    } else {
      const head = Math.max(s.width * 4, 0.025);
      const [b1, b2] = arrowHead(s.from, s.to, head, aspect);
      ctx.moveTo(...px(s.from));
      ctx.lineTo(...px(s.to));
      ctx.moveTo(...px(b1));
      ctx.lineTo(...px(s.to));
      ctx.lineTo(...px(b2));
      ctx.stroke();
    }
  }
  ctx.restore();
}
