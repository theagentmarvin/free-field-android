#!/usr/bin/env node
// Generates a LARGE synthetic vector-heavy A0 plan PDF for render stress tests.
// Never bundled in the APK: e2e pushes it to the device with adb.
//
//   node scripts/gen-large-plan.mjs [out.pdf] [segments]
//
// Default output: .cache/large-a0.pdf (git-ignored via .cache/), ~15 MB.
// A0 portrait/landscape = 3370 x 2384 pt. The page is a dense deterministic CAD-like
// drawing: a grid, thousands of "walls" (rectangles), hatching, and a field of short
// curved strokes, so the operator list is huge but the file has no images.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const out = resolve(process.argv[2] ?? ".cache/large-a0.pdf");
const segments = Number(process.argv[3] ?? 420_000);
const W = 3370;
const H = 2384;

// Deterministic PRNG (mulberry32) so the file is reproducible.
let seed = 0xa0a0a0;
const rnd = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const f = (n) => n.toFixed(2);

const ops = [];
ops.push("0.25 w");
// Grid
ops.push("0.8 0.8 0.8 RG 0.2 w");
for (let x = 0; x <= W; x += 20) ops.push(`${x} 0 m ${x} ${H} l S`);
for (let y = 0; y <= H; y += 20) ops.push(`0 ${y} m ${W} ${y} l S`);
// Walls, hatching and curved strokes
ops.push("0 0 0 RG 0.35 w");
for (let i = 0; i < segments; i++) {
  const x = rnd() * W;
  const y = rnd() * H;
  const kind = i % 4;
  if (kind === 0) ops.push(`${f(x)} ${f(y)} ${f(10 + rnd() * 60)} ${f(2 + rnd() * 6)} re S`);
  else if (kind === 1) ops.push(`${f(x)} ${f(y)} m ${f(x + rnd() * 40 - 20)} ${f(y + rnd() * 40 - 20)} l S`);
  else if (kind === 2) {
    const d = () => rnd() * 30 - 15;
    ops.push(`${f(x)} ${f(y)} m ${f(x + d())} ${f(y + d())} ${f(x + d())} ${f(y + d())} ${f(x + d())} ${f(y + d())} c S`);
  } else ops.push(`${f(x)} ${f(y)} m ${f(x + 8)} ${f(y + 8)} l ${f(x + 16)} ${f(y)} l ${f(x + 24)} ${f(y + 8)} l S`);
}
// Title text with a standard font (exercises standard_fonts loading)
ops.push("BT /F1 96 Tf 200 200 Td (SYNTHETIC A0 STRESS PLAN) Tj ET");

const content = ops.join("\n");
const objs = [
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>`,
  `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
];
let pdf = "%PDF-1.4\n";
const offsets = [];
objs.forEach((o, i) => {
  offsets.push(Buffer.byteLength(pdf));
  pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
});
const xref = Buffer.byteLength(pdf);
pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
for (const o of offsets) pdf += `${String(o).padStart(10, "0")} 00000 n \n`;
pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, pdf, "latin1");
console.log(`wrote ${out} (${(Buffer.byteLength(pdf) / 1048576).toFixed(1)} MB, ${segments} shapes, ${W}x${H} pt)`);
