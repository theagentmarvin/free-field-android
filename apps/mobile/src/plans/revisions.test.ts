import { describe, expect, it } from "vitest";
import type { PdfVersionRecord } from "@ff/types";
import { defaultComparePair, listRevisions, pinRevision, pinRevisionBadge, revisionPosition, revisionsBadge, revisionTitle } from "./revisions";
import { groupPlans } from "./planModel";
import { pinsForPlan } from "./pins";
import type { PanelTask } from "@ff/tasks-react";

const ver = (id: string, n: number, isLatest = false, storedAt = 1000 * n): PdfVersionRecord =>
  ({ id, pdfFileId: "f1", versionNumber: n, name: `PLAN ${n}.pdf`, size: 1, contentHash: "h", pageCount: 1, width: 100, height: 100, storedAt, blobKey: `b${n}`, isLatest }) as PdfVersionRecord;
const V = [ver("v1", 1), ver("v2", 2, true)];

describe("revision history", () => {
  it("lists every revision newest first with number, name, date and the on-device flag", () => {
    const list = listRevisions([V[0], ver("v3", 3), V[1]], new Set(["v2", "v3"]));
    expect(list.map((r) => [r.number, r.isLatest, r.onDevice])).toEqual([
      [3, false, true], // isLatest flag wins over the highest number
      [2, true, true],
      [1, false, false],
    ]);
    expect(list[1]).toMatchObject({ name: "PLAN 2.pdf", storedAt: 2000, versionId: "v2" });
    expect(listRevisions(V, null).every((r) => r.onDevice)).toBe(true); // demo: everything is available
  });

  it("labels the position of a revision and flags an older one", () => {
    expect(revisionPosition(V, "v1")).toEqual({ number: 1, total: 2, isLatest: false });
    expect(revisionTitle(revisionPosition(V, "v1")!)).toBe("Revision 1 of 2, not the latest");
    expect(revisionTitle(revisionPosition(V, "v2")!)).toBe("Revision 2 of 2 (latest)");
    expect(revisionPosition(V, "nope")).toBeNull();
  });

  it("shows a revisions badge only when a plan has more than one", () => {
    expect(revisionsBadge(1)).toBeNull();
    expect(revisionsBadge(2)).toBe("2 revisions");
  });

  it("counts the revisions of each plan in the plans list", () => {
    const g = groupPlans({
      buildings: [{ id: "b1", name: "T" }],
      files: [{ id: "f1", buildingId: "b1", name: "P-101", createdAt: 0, updatedAt: 0 }, { id: "f2", buildingId: "b1", name: "S-1", createdAt: 0, updatedAt: 0 }],
      versions: [...V, { ...ver("w1", 1, true), pdfFileId: "f2" }],
      folders: [],
      assignments: [],
      calibrations: [],
    });
    const by = Object.fromEntries(g[0].groups.flatMap((x) => x.plans).map((p) => [p.name, p.revisionCount]));
    expect(by).toEqual({ "P-101": 2, "S-1": 1 });
  });

  it("picks the previous revision against the newest one as the default compare pair", () => {
    const revs = listRevisions([ver("v1", 1), ver("v2", 2), ver("v3", 3, true)], null);
    expect(defaultComparePair(revs)).toEqual({ base: "v2", revision: "v3" });
    expect(defaultComparePair(revs, "v2")).toEqual({ base: "v1", revision: "v2" });
    expect(defaultComparePair(revs, "v1")).toEqual({ base: "v1", revision: "v2" }); // nothing older: against the next one
    expect(defaultComparePair(listRevisions([ver("v1", 1, true)], null))).toBeNull();
    // a revision that is not on the device cannot be compared
    expect(defaultComparePair(listRevisions(V, new Set(["v2"])))).toBeNull();
  });
});

describe("stale pins", () => {
  it("names the revision a pin was placed on when it is known", () => {
    expect(pinRevision("v1", "v2", V)).toEqual({ kind: "earlier", number: 1, versionId: "v1" });
    expect(pinRevisionBadge(pinRevision("v1", "v2", V))).toBe("R1");
    expect(pinRevision("v2", "v2", V)).toEqual({ kind: "current" });
    expect(pinRevisionBadge({ kind: "current" })).toBeNull();
  });
  it("tells a deleted version and a legacy pin (no version stored) apart", () => {
    expect(pinRevision("gone", "v2", V)).toEqual({ kind: "unknown", legacy: false });
    expect(pinRevision(undefined, "v2", V)).toEqual({ kind: "unknown", legacy: true });
    expect(pinRevisionBadge({ kind: "unknown", legacy: true })).toBeNull();
  });
  it("pinsForPlan carries the revision of every pin", () => {
    const at = (id: string, pdfVersionId?: string) =>
      ({ id, num: 1, title: id, status: 20, pending: false, location: { pdf: { pdfFileId: "f1", page: 1, uv: [0.5, 0.5], calibId: "c", ...(pdfVersionId ? { pdfVersionId } : {}) } } }) as unknown as PanelTask;
    const pins = pinsForPlan([at("a", "v1"), at("b", "v2"), at("c")], "f1", "v2", 1, V);
    const by = Object.fromEntries(pins.map((p) => [p.taskId, p.revision]));
    expect(by.a).toEqual({ kind: "earlier", number: 1, versionId: "v1" });
    expect(by.b).toEqual({ kind: "current" });
    expect(by.c).toEqual({ kind: "unknown", legacy: true });
  });
});
