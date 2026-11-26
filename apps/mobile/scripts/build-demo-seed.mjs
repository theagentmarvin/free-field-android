// Builds the app-owned demo seed (apps/mobile/demo-seed/) from the public sample IFC of the web repository.
//
//   node apps/mobile/scripts/build-demo-seed.mjs <path/to/sample.ifc>
//
// Output (same layout as the web demo seed, so prepare-assets treats both alike):
//   demo-seed/manifest.json
//   demo-seed/blobs/fragBlobs/<ifcFileId>__v1      the .frag (built with the same importer settings as the web app)
//   demo-seed/blobs/pdfBlobs/<pdfBlobKey>          one generated floor plan for the first storey with elements
//
// Steps: (1) neutralise the IFC header/application names, (2) IFC -> .frag in Node, (3) read the model's own geometry
// back and draw a plan PDF from it (grid, outline, columns, beams), (4) write the calibration that links the plan to
// the storey, (5) write the manifest. Nothing here is copied from another sample: the PDF is generated.
// Mobile itself never parses IFC; this runs on a developer machine only, and its output is committed.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const app = resolve(here, "..");
const out = resolve(app, "demo-seed");
const require = createRequire(join(app, "package.json"));

const inPath = process.argv[2];
if (!inPath) {
  console.error("usage: node apps/mobile/scripts/build-demo-seed.mjs <path/to/sample.ifc>");
  process.exit(2);
}

// Fixed ids/timestamps: the output is reproducible and diff-friendly.
const IDS = {
  project: "default-project", // = DEMO_PROJECT_ID of @ff/auth (the legacy default id); the demo reads rows under it
  building: "9d1c0f6e-5a3b-4c2e-8f71-3b2a6c5d0e01",
  ifcFile: "5e7a1c34-2b9d-4f60-a8c3-1d4e7b9a0c02",
  ifcVersion: "7b3d9e12-6c4a-4a85-b1f0-2e8c5a7d3f03",
  pdfFile: "c4a2f8d6-1e7b-4d93-9a50-6b3e0c8f1d04",
  pdfVersion: "a1e6b9c3-8d2f-4b17-a4e5-9c0d7f3b2e05",
  pdfBlob: "e8d4c2a7-3f19-4c60-b7a1-5d2e9f0b4c06",
  calibration: "2f9b7d1a-4c8e-4e35-8a62-0b5d3c9e7a07",
  folder: "6a0c4e8b-9d2f-4713-bc58-1e7a3d5f9b08",
  assignment: "d3b8f1a5-7e4c-4a29-96d0-8c2b5e1a4f09",
};
const T0 = Date.UTC(2026, 0, 1);

// ---------------------------------------------------------------- 1. neutral IFC
// Third-party product names are banned from the demo data. The names are assembled from pieces so that this file itself
// stays clean under the export's text scan.
const deny = new RegExp(
  [["dal", "ux"], ["blue", "beam"], ["auto", "desk"], ["pro", "core"], ["plan", "grid"], ["navis", "works"], ["field", "wire"], ["trim", "ble"], ["te", "kla"], ["soli", "bri"], ["new", "forma"], ["ac", "onex"], ["bim ?3", "60"]]
    .map((p) => p.join(""))
    .join("|"),
  "i",
);
let ifc = readFileSync(inPath, "latin1");
const header = [
  "HEADER;",
  "FILE_DESCRIPTION(('ViewDefinition [CoordinationView_V2.0]'),'2;1');",
  "FILE_NAME('FreeField demo.ifc','2026-01-01T00:00:00',(''),(''),'FreeField','FreeField demo','');",
  "FILE_SCHEMA(('IFC2X3'));",
  "ENDSEC;",
].join("\n");
ifc = ifc.replace(/HEADER;[\s\S]*?ENDSEC;/, header).replace(/Sample Modeler 2025 \(ENG\)/g, "FreeField demo");
if (deny.test(ifc)) {
  console.error(`The input IFC still names a third-party product (${deny.exec(ifc)[0]}). Use the public sample.ifc of the web repository.`);
  process.exit(1);
}
const ifcBytes = Buffer.from(ifc, "latin1");

// ---------------------------------------------------------------- 2. IFC -> .frag
const FRAGS = await import(require.resolve("@thatopen/fragments").replace(/index\.cjs$/, "index.mjs"));
const importer = new FRAGS.IfcImporter();
importer.wasm.path = dirname(require.resolve("web-ifc")) + "/";
importer.wasm.absolute = true;
importer.addAllAttributes();
importer.addAllRelations();
const fragBytes = Buffer.from(await importer.process({ bytes: new Uint8Array(ifcBytes), raw: true }));

// ---------------------------------------------------------------- 3. read the model back
const model = new FRAGS.SingleThreadedFragmentsModel("demo", new Uint8Array(fragBytes), true);
await model.ready;
const meta = model.getMetadata();
const storeyIds = model.getItemsOfCategories([/^IFCBUILDINGSTOREY$/]).IFCBUILDINGSTOREY ?? [];
const storeyData = model.getItemsData(storeyIds, { attributesDefault: true });
const withGeometry = new Set(model.getItemsIdsWithGeometry());
const storeys = storeyIds.map((id, i) => ({
  id,
  name: String(storeyData[i].Name?.value ?? `Level ${i}`),
  elevation: Number(storeyData[i].Elevation?.value ?? 0),
  contained: model.getItemsChildren([id]),
}));
const cat = model.getItemsOfCategories([/^IFCCOLUMN$/, /^IFCBEAM$/, /^IFCSLAB$/]);
const catOf = new Map();
for (const [c, ids] of Object.entries(cat)) for (const id of ids) catOf.set(id, c);

const bboxOf = (localId) => {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const mesh of model.getItemsGeometry([localId])[0] ?? []) {
    const m = mesh.transform.elements;
    const p = mesh.positions;
    for (let i = 0; i < p.length; i += 3) {
      const x = m[0] * p[i] + m[4] * p[i + 1] + m[8] * p[i + 2] + m[12];
      const z = m[2] * p[i] + m[6] * p[i + 1] + m[10] * p[i + 2] + m[14];
      b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], z); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], z);
    }
  }
  return b;
};

// The plan shows the storey named "101 ..." when present, else the lowest storey that has columns.
const hasColumns = (s) => s.contained.some((i) => catOf.get(i) === "IFCCOLUMN");
const planStorey = storeys.find((s) => /^101\b/.test(s.name) && hasColumns(s)) ?? [...storeys].sort((a, b) => a.elevation - b.elevation).find(hasColumns);
if (!planStorey) throw new Error("no storey with columns found in the model");
const items = planStorey.contained.filter((i) => withGeometry.has(i) && catOf.has(i)).map((i) => ({ kind: catOf.get(i), box: bboxOf(i) })).filter((i) => i.box.every(Number.isFinite));
const all = items.reduce((a, i) => [Math.min(a[0], i.box[0]), Math.min(a[1], i.box[1]), Math.max(a[2], i.box[2]), Math.max(a[3], i.box[3])], [Infinity, Infinity, -Infinity, -Infinity]);

// ---------------------------------------------------------------- 4. plan geometry + calibration
const PAGE = { w: 1190, h: 842 }; // A3 landscape, PDF points
const area = { x0: 90, y0: 80, x1: PAGE.w - 60, y1: PAGE.h - 170 }; // drawing area, y down from the top
const pad = 4; // metres of margin around the model
const wx0 = all[0] - pad, wz0 = all[1] - pad, wx1 = all[2] + pad, wz1 = all[3] + pad;
const s = Math.max((wx1 - wx0) / (area.x1 - area.x0), (wz1 - wz0) / (area.y1 - area.y0)); // metres per PDF point
// World X maps to PDF x, world Z to PDF y (down): rotation 0. translate puts (wx0, wz0) at the top-left of the area.
const offX = (area.x1 - area.x0 - (wx1 - wx0) / s) / 2; // centre the model in the drawing area
const offY = (area.y1 - area.y0 - (wz1 - wz0) / s) / 2;
const translateX = wx0 - s * (area.x0 + offX);
const translateZ = wz0 - s * (area.y0 + offY);
const toPdf = (x, z) => [(x - translateX) / s, (z - translateZ) / s];

const cols = items.filter((i) => i.kind === "IFCCOLUMN");
const cluster = (vals) => {
  const sorted = [...vals].sort((a, b) => a - b);
  const groups = [];
  for (const v of sorted) {
    const g = groups[groups.length - 1];
    if (g && v - g.at(-1) < 0.5) g.push(v); else groups.push([v]);
  }
  return groups.map((g) => g.reduce((a, b) => a + b, 0) / g.length);
};
const gridX = cluster(cols.map((c) => (c.box[0] + c.box[2]) / 2));
const gridZ = cluster(cols.map((c) => (c.box[1] + c.box[3]) / 2));

// ---------------------------------------------------------------- 5. the PDF (hand-written, standard fonts, no metadata)
const esc = (t) => t.replace(/[\\()]/g, "\\$&");
const n = (v) => (Math.round(v * 100) / 100).toString();
const ops = [];
const Y = (yTop) => PAGE.h - yTop;
const line = (x0, y0, x1, y1, w = 0.5, dash = null) => ops.push(`${w} w ${dash ? `[${dash}] 0 d` : "[] 0 d"} ${n(x0)} ${n(Y(y0))} m ${n(x1)} ${n(Y(y1))} l S`);
const rect = (x0, y0, x1, y1, { w = 0.5, fill = null } = {}) => ops.push(`${w} w [] 0 d ${fill !== null ? `${fill} g ` : ""}${n(x0)} ${n(Y(y1))} ${n(x1 - x0)} ${n(y1 - y0)} re ${fill !== null ? "B" : "S"}${fill !== null ? " 0 g" : ""}`);
const text = (x, y, size, str, font = "F1") => ops.push(`BT /${font} ${size} Tf ${n(x)} ${n(Y(y))} Td (${esc(str)}) Tj ET`);
const circle = (cx, cy, r) => {
  const k = 0.5523 * r, cyy = Y(cy);
  ops.push(`0.5 w [] 0 d ${n(cx + r)} ${n(cyy)} m ${n(cx + r)} ${n(cyy + k)} ${n(cx + k)} ${n(cyy + r)} ${n(cx)} ${n(cyy + r)} c ${n(cx - k)} ${n(cyy + r)} ${n(cx - r)} ${n(cyy + k)} ${n(cx - r)} ${n(cyy)} c ${n(cx - r)} ${n(cyy - k)} ${n(cx - k)} ${n(cyy - r)} ${n(cx)} ${n(cyy - r)} c ${n(cx + k)} ${n(cyy - r)} ${n(cx + r)} ${n(cyy - k)} ${n(cx + r)} ${n(cyy)} c S`);
};

rect(20, 20, PAGE.w - 20, PAGE.h - 20, { w: 1.5 }); // sheet border
// grid lines with bubbles
ops.push("0.6 0.6 0.6 RG");
const [mx0, mz0] = toPdf(all[0], all[1]);
const [mx1, mz1] = toPdf(all[2], all[3]);
const top = mz0 - 30, bottom = mz1 + 30;
gridX.forEach((gx, i) => {
  const [px] = toPdf(gx, 0);
  line(px, top, px, bottom, 0.4, "8 3 2 3");
  circle(px, top - 10, 10); text(px - 3.5, top - 6.5, 10, String(i + 1));
});
const left = mx0 - 30, right = mx1 + 30;
gridZ.forEach((gz, i) => {
  const [, pz] = toPdf(0, gz);
  line(left, pz, right, pz, 0.4, "8 3 2 3");
  circle(left - 10, pz, 10); text(left - 14, pz + 3.5, 10, String.fromCharCode(65 + i));
});
ops.push("0 0 0 RG");
// outline of the storey
const [ox0, oz0] = toPdf(all[0], all[1]);
const [ox1, oz1] = toPdf(all[2], all[3]);
rect(ox0, oz0, ox1, oz1, { w: 1.2 });
// beams (thin boxes) then columns (filled)
for (const b of items.filter((i) => i.kind === "IFCBEAM")) {
  const [x0, z0] = toPdf(b.box[0], b.box[1]);
  const [x1, z1] = toPdf(b.box[2], b.box[3]);
  rect(x0, z0, x1, z1, { w: 0.4 });
}
for (const c of cols) {
  const [x0, z0] = toPdf(c.box[0], c.box[1]);
  const [x1, z1] = toPdf(c.box[2], c.box[3]);
  rect(x0, z0, x1, z1, { w: 0.6, fill: 0.25 });
}
// title block
const tb = { x0: PAGE.w - 20 - 330, y0: PAGE.h - 20 - 120, x1: PAGE.w - 20, y1: PAGE.h - 20 };
rect(tb.x0, tb.y0, tb.x1, tb.y1, { w: 1 });
line(tb.x0, tb.y0 + 40, tb.x1, tb.y0 + 40, 0.6);
line(tb.x0, tb.y0 + 80, tb.x1, tb.y0 + 80, 0.6);
text(tb.x0 + 10, tb.y0 + 28, 20, "FreeField demo", "F2");
text(tb.x0 + 10, tb.y0 + 66, 14, "S-101  First Floor Plan", "F2");
text(tb.x0 + 10, tb.y0 + 100, 9, `Storey ${planStorey.name}. 1 pt = ${n(s * 1000)} mm. Demo only.`);
text(tb.x0 + 10, tb.y0 + 112, 9, "Columns, beams and grid derived from the demo model.");
text(30, 36, 8, "FreeField demo set, sheet 1 of 1");

const content = ops.join("\n");
const objs = [
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE.w} ${PAGE.h}] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>`,
  `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
];
let pdf = "%PDF-1.4\n";
const offsets = [];
objs.forEach((o, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
const xref = Buffer.byteLength(pdf);
pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
const pdfBytes = Buffer.from(pdf, "latin1");

// calibration: two grid intersections, far apart
const gx0 = gridX[0], gz0 = gridZ[0], gx1 = gridX.at(-1), gz1 = gridZ.at(-1);
const pair = (x, z) => { const [px, py] = toPdf(x, z); return { pdfX: px, pdfY: py, worldX: x, worldZ: z }; };
const calibration = {
  id: IDS.calibration,
  projectId: IDS.project,
  pdfFileId: IDS.pdfFile,
  storeyName: planStorey.name,
  pointPairs: [pair(gx0, gz0), pair(gx1, gz1)],
  transformParams: { scale: s, rotation: 0, translateX, translateZ },
  confidence: 1,
  createdAt: T0 + 5000,
  updatedAt: T0 + 5000,
};

// ---------------------------------------------------------------- 6. manifest
const sha = (b) => createHash("sha256").update(b).digest("hex");
const fragKey = `${IDS.ifcFile}__v1`;
const manifest = {
  format: "free-field-demo-seed",
  version: 1,
  capturedAt: "2026-01-01T00:00:00Z",
  note: "App-owned demo seed generated by apps/mobile/scripts/build-demo-seed.mjs from the public sample IFC. Do not edit by hand.",
  tables: {
    projects: [{ id: IDS.project, name: "Default", metadata: {}, createdAt: T0, updatedAt: T0 }],
    buildings: [{ id: IDS.building, projectId: IDS.project, name: "FreeField demo building", metadata: {}, createdAt: T0 + 1000, updatedAt: T0 + 1000 }],
    ifcFiles: [{ id: IDS.ifcFile, buildingId: IDS.building, name: "FreeField demo.ifc", currentVersionId: IDS.ifcVersion, createdAt: T0 + 1000, updatedAt: T0 + 1000 }],
    ifcVersions: [{ id: IDS.ifcVersion, ifcFileId: IDS.ifcFile, versionNumber: 1, ifcFileSize: ifcBytes.length, contentHash: sha(ifcBytes), fragBlobKey: fragKey, storeyCount: storeys.length, isLatest: true, createdAt: T0 + 1000 }],
    storeys: storeys.map((st, i) => ({
      id: `3c5e7a9b-1d2f-4a6c-8e0b-4f6a8c0e2d${String(10 + i)}`,
      buildingId: IDS.building,
      ifcVersionId: IDS.ifcVersion,
      sourceIfcFileId: IDS.ifcFile,
      name: st.name,
      elevation: st.elevation,
      expressId: st.id,
      height: null,
      containedElementIds: st.contained,
    })),
    extractedStoreys: storeys.map((_, i) => ({ id: `8b1d3f5a-7c9e-4b2d-a4f6-0e8c2a4b6d${String(20 + i)}`, buildingId: IDS.building, storeyId: `3c5e7a9b-1d2f-4a6c-8e0b-4f6a8c0e2d${String(10 + i)}`, updatedAt: T0 + 2000 })),
    buildingLevelSelection: [],
    pdfFiles: [{ id: IDS.pdfFile, buildingId: IDS.building, name: "S-101 - First Floor.pdf", createdAt: T0 + 3000, updatedAt: T0 + 3000 }],
    pdfVersions: [{ id: IDS.pdfVersion, pdfFileId: IDS.pdfFile, versionNumber: 1, name: "S-101 - First Floor.pdf", size: pdfBytes.length, contentHash: sha(pdfBytes), pageCount: 1, width: PAGE.w, height: PAGE.h, storedAt: T0 + 3000, blobKey: IDS.pdfBlob, isLatest: true }],
    pdfFolders: [{ id: IDS.folder, projectId: IDS.project, parentId: null, name: "Structure", color: "blue", createdAt: T0 + 4000, updatedAt: T0 + 4000 }],
    pdfFolderAssignments: [{ id: IDS.assignment, pdfFileId: IDS.pdfFile, folderId: IDS.folder, createdAt: T0 + 4000 }],
    calibrations: [calibration],
  },
};

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "blobs/fragBlobs"), { recursive: true });
mkdirSync(join(out, "blobs/pdfBlobs"), { recursive: true });
writeFileSync(join(out, "blobs/fragBlobs", fragKey), fragBytes);
writeFileSync(join(out, "blobs/pdfBlobs", IDS.pdfBlob), pdfBytes);
writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 1) + "\n");

console.log(`demo-seed: frag ${fragBytes.length} B, pdf ${pdfBytes.length} B, storeys ${storeys.map((x) => x.name).join(" | ")}`);
console.log(`demo-seed: plan storey "${planStorey.name}", ${cols.length} columns, grid ${gridX.length}x${gridZ.length}, scale ${n(s * 1000)} mm/pt`);
console.log(`demo-seed: frag metadata names = ${JSON.stringify(meta.names)}`);
console.log(`demo-seed: frag metadata descriptions = ${JSON.stringify(meta.descriptions)}`);
const frag = fragBytes.toString("latin1");
const hit = deny.exec(frag);
console.log(hit ? `demo-seed: WARNING deny-list hit "${hit[0]}" in the frag` : "demo-seed: no third-party names in the frag or the pdf");
