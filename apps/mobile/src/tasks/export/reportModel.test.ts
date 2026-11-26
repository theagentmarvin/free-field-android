import { describe, expect, it } from "vitest";
import { buildReportBlock, buildReportMeta, blobRef, fmtDay, type ReportInputTask } from "./reportModel";

const NOW = new Date(2026, 10, 25, 12, 0).getTime();
const day = 86_400_000;

const row = (over: Record<string, unknown> = {}): ReportInputTask["row"] =>
  ({
    id: "t1", num: 12, title: "Cracked slab", status: 20, description: "Hairline\ncrack", type: "defect", priority: "high",
    assigneeName: "Ana", deadline: NOW - day, buildingName: "Tower A", storeyName: "Level 02", createdBy: "Bo", createdAt: NOW - 5 * day, updatedAt: NOW - day,
    checklist: [{ id: "c1", text: "Measure", done: true }, { id: "c2", text: "Photo", done: false }],
    location: { text: "Grid B4", bim: { elements: [] }, pdf: { page: 3 } }, locationThumbPath: "p/t1/loc3d.jpg",
    photos: [], ...over,
  }) as unknown as ReportInputTask["row"];

const entry = (over: Record<string, unknown> = {}) => ({ action: "comment", by: "Ana", at: NOW, statusFrom: null, statusTo: null, text: "checked", photos: [], ...over }) as ReportInputTask["entries"][number];

describe("report block assembly (web report content and order)", () => {
  it("number, title, status, description and the field grid in the web's order", () => {
    const b = buildReportBlock({ row: row(), entries: [], photos: [] }, { now: NOW });
    expect(b.num).toBe("T012");
    expect(b.title).toBe("Cracked slab");
    expect(b.statusLabel).toBe("Ongoing");
    expect(b.description).toBe("Hairline\ncrack");
    expect(b.fields.map((f) => f.k)).toEqual(["Type", "Priority", "Assignee", "Deadline", "Building / level", "Checklist", "Location", "Created by", "Updated"]);
    const f = Object.fromEntries(b.fields.map((x) => [x.k, x]));
    expect(f["Type"]!.v).toBe("Defect");
    expect(f["Priority"]!.v).toBe("High");
    expect(f["Building / level"]!.v).toBe("Tower A / Level 02");
    expect(f["Checklist"]!.v).toBe("1/2 done");
    expect(f["Location"]!.v).toBe("Grid B4 - 3D pin, plan pin, page 3");
    expect(f["Deadline"]!.flag).toBe("late");
    expect(f["Deadline"]!.v).toContain("overdue");
    expect(f["Deadline"]!.v.startsWith(fmtDay(NOW - day))).toBe(true);
    expect(b.checklist).toEqual([{ text: "Measure", done: true }, { text: "Photo", done: false }]);
  });

  it("location snapshots: the plan one first for a dual location, then the 3D one", () => {
    const dual = row({ location: { origin: "linkview", text: "x", bim: { elements: [] }, pdf: { page: 1 }, thumb: { storagePath: "p/t1/loc3d.jpg" }, thumb2d: { storagePath: "p/t1/loc2d.jpg" } } });
    const b = buildReportBlock({ row: dual, entries: [], photos: [] }, { now: NOW });
    expect(b.locationImages.map((i) => i.label)).toEqual(["Plan snapshot", "Location snapshot"]);
    expect(b.locationImages[1]!.ref).toBe("p/t1/loc3d.jpg");
  });

  it("limits task photos (the web prints 4) and counts the rest", () => {
    const photos = Array.from({ length: 7 }, (_, i) => ({ ref: `p${i}`, caption: i === 0 ? "first" : null }));
    const b = buildReportBlock({ row: row(), entries: [], photos }, { now: NOW });
    expect(b.photos.map((p) => p.ref)).toEqual(["p0", "p1", "p2", "p3"]);
    expect(b.photos[0]!.caption).toBe("first");
    expect(b.morePhotos).toBe(3);
    expect(buildReportBlock({ row: row(), entries: [], photos }, { now: NOW, maxPhotos: 0 }).photos).toEqual([]);
  });

  it("timeline: transitions, queued state, comment photos limited, creation photos not repeated", () => {
    const b = buildReportBlock(
      {
        row: row(),
        photos: [],
        entries: [
          entry({ action: "create", text: "Cracked slab", photos: [{ ref: "p0" }] }),
          entry({ action: "comment", text: "see photos", photos: [{ ref: "a" }, { ref: "b" }, { ref: blobRef("k1") }] }),
          entry({ action: "complete", statusFrom: 20, statusTo: 40, pending: true }),
        ],
      },
      { now: NOW },
    );
    expect(b.entries.map((e) => e.title)).toEqual(["Created", "Comment", "Submitted for approval"]);
    expect(b.entries[0]!.text).toBe("");
    expect(b.entries[0]!.photos).toEqual([]);
    expect(b.entries[1]!.photos.map((p) => p.ref)).toEqual(["a", "b"]);
    expect(b.entries[2]!.transition).toBe("Ongoing > Awaiting approval");
    expect(b.entries[2]!.state).toBe("queued, not yet committed");
  });

  it("a task still queued for creation reads as New", () => {
    expect(buildReportBlock({ row: row({ num: 0 }), entries: [], photos: [] }, { now: NOW }).num).toBe("New");
  });
});

describe("report meta (title page)", () => {
  it("counts tasks by status and lists the buildings", () => {
    const m = buildReportMeta(
      [
        { status: 20, buildingName: "Tower B" },
        { status: 20, buildingName: "Tower A" },
        { status: 65, buildingName: "Tower A" },
      ] as never,
      { projectName: " Campus ", filterNote: "Status: Open", printedBy: "Ana", now: NOW, totalInView: 9 },
    );
    expect(m.projectName).toBe("Campus");
    expect(m.buildings).toEqual(["Tower A", "Tower B"]);
    expect(m.statusCounts).toEqual([{ label: "Ongoing", count: 2 }, { label: "Approved", count: 1 }]);
    expect(m.taskCount).toBe(3);
    expect(m.totalInView).toBe(9);
    expect(m.filterNote).toBe("Status: Open");
  });
});
