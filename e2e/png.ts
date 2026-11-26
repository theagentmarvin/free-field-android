import { inflateSync } from "node:zlib";

export interface Raster {
  width: number;
  height: number;
  /** RGBA, row-major */
  data: Uint8Array;
}

/** Minimal PNG decoder (8-bit, non-interlaced, RGB/RGBA/grey): enough for adb framebuffer captures. */
export function decodePng(buf: Buffer): Raster {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let off = 8;
  let width = 0;
  let height = 0;
  let colour = 0;
  const idat: Buffer[] = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const body = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      if (body[8] !== 8) throw new Error(`unsupported bit depth ${body[8]}`);
      colour = body[9];
      if (body[12] !== 0) throw new Error("interlaced PNG not supported");
    } else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    off += 12 + len;
  }
  const bpp = colour === 6 ? 4 : colour === 2 ? 3 : colour === 0 ? 1 : 0;
  if (!bpp) throw new Error(`unsupported colour type ${colour}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const px = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[y * stride + x - bpp] : 0;
      const b = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? px[(y - 1) * stride + x - bpp] : 0;
      let v = line[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[y * stride + x] = v & 255;
    }
  }
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    if (bpp === 4) data.set(px.subarray(i * 4, i * 4 + 4), i * 4);
    else if (bpp === 3) data.set([px[i * 3], px[i * 3 + 1], px[i * 3 + 2], 255], i * 4);
    else data.set([px[i], px[i], px[i], 255], i * 4);
  }
  return { width, height, data };
}

export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Fraction of pixels in `r` that differ from `bg` by more than `tol` (sum of channel deltas), plus distinct coarse colours. */
export function geometryStats(img: Raster, r: Region, bg: [number, number, number] = [242, 243, 244], tol = 40): { fraction: number; colours: number } {
  let n = 0;
  let diff = 0;
  const seen = new Set<number>();
  const x1 = Math.min(img.width, Math.floor(r.x + r.w));
  const y1 = Math.min(img.height, Math.floor(r.y + r.h));
  for (let y = Math.max(0, Math.floor(r.y)); y < y1; y += 2) {
    for (let x = Math.max(0, Math.floor(r.x)); x < x1; x += 2) {
      const i = (y * img.width + x) * 4;
      const d = Math.abs(img.data[i] - bg[0]) + Math.abs(img.data[i + 1] - bg[1]) + Math.abs(img.data[i + 2] - bg[2]);
      n++;
      if (d > tol) {
        diff++;
        seen.add(((img.data[i] >> 4) << 8) | ((img.data[i + 1] >> 4) << 4) | (img.data[i + 2] >> 4));
      }
    }
  }
  return { fraction: n ? diff / n : 0, colours: seen.size };
}

/** Mean absolute channel difference (0..255) between two same-size rasters over `r`. */
export function meanDiff(a: Raster, b: Raster, r: Region): number {
  let sum = 0;
  let n = 0;
  const x1 = Math.min(a.width, b.width, Math.floor(r.x + r.w));
  const y1 = Math.min(a.height, b.height, Math.floor(r.y + r.h));
  for (let y = Math.max(0, Math.floor(r.y)); y < y1; y += 2) {
    for (let x = Math.max(0, Math.floor(r.x)); x < x1; x += 2) {
      const i = (y * a.width + x) * 4;
      const j = (y * b.width + x) * 4;
      sum += Math.abs(a.data[i] - b.data[j]) + Math.abs(a.data[i + 1] - b.data[j + 1]) + Math.abs(a.data[i + 2] - b.data[j + 2]);
      n += 3;
    }
  }
  return n ? sum / n : 0;
}
