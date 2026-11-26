import { describe, expect, it, vi } from "vitest";
import type { PdfFileRecord, PdfVersionRecord } from "@ff/types";
import { groupPlans, latestVersion, UNFILED } from "./planModel";
import { encodeAnchor, newTaskUrl, parseAnchor } from "./anchor";
import { DemoPlanSource, pdfKey } from "./planSource";
import { MemoryBlobStore } from "../storage";
import { pinsForPlan } from "./pins";
import type { PanelTask } from "@ff/tasks-react";

const file = (id: string, name: string, buildingId = "b1"): PdfFileRecord => ({ id, buildingId, name, createdAt: 0, updatedAt: 0 });
const ver = (id: string, pdfFileId: string, n: number, isLatest = false): PdfVersionRecord => ({
  id, pdfFileId, versionNumber: n, name: "x.pdf", size: 1, contentHash: "h", pageCount: 1, width: 100, height: 100, storedAt: 0, blobKey: `blob-${id}`, isLatest,
});

describe("groupPlans", () => {
  const input = {
    buildings: [{ id: "b1", name: "Tower" }, { id: "b0", name: "Annex" }, { id: "b2", name: "Empty" }],
    files: [file("f1", "S-101"), file("f2", "A-001"), file("f3", "L-1"), file("f4", "Old", "b0"), file("f5", "NoVersion")],
    versions: [ver("v1", "f1", 1), ver("v1b", "f1", 2), ver("v2", "f2", 1), ver("v3", "f3", 3, true), ver("v3b", "f3", 4), ver("v4", "f4", 1)],
    folders: [{ id: "d1", projectId: "p", parentId: null, name: "STR", color: "blue", createdAt: 0, updatedAt: 0 }],
    assignments: [{ id: "a1", pdfFileId: "f1", folderId: "d1", createdAt: 0 }],
    calibrations: [{ id: "c1", projectId: "p", pdfFileId: "f2", storeyName: "Level 2", pointPairs: [], transformParams: {}, confidence: 1, createdAt: 0, updatedAt: 0 }],
  } as unknown as Parameters<typeof groupPlans>[0];

  it("groups building -> folder/storey -> plan, sorted, skipping empties", () => {
    const g = groupPlans(input);
    expect(g.map((b) => b.buildingName)).toEqual(["Annex", "Tower"]);
    const tower = g[1];
    expect(tower.groups.map((x) => x.name)).toEqual(["Level 2", "STR", UNFILED]);
    expect(tower.groups[1].plans[0].name).toBe("S-101");
    expect(g[0].groups[0].name).toBe(UNFILED);
  });
  it("uses the latest version (flag first, else highest number)", () => {
    const g = groupPlans(input);
    const byName = Object.fromEntries(g.flatMap((b) => b.groups.flatMap((x) => x.plans)).map((p) => [p.name, p.version.id]));
    expect(byName["S-101"]).toBe("v1b");
    expect(byName["L-1"]).toBe("v3");
    expect(latestVersion([])).toBeUndefined();
  });
  it("cloud mode: shows the newest version on the device and lists the rest as not offline", () => {
    const downloaded = new Map<string, PdfVersionRecord | null>([
      ["f1", input.versions[0]], // v1 downloaded although v1b is newer: the update is still pending
      ["f2", null], // synced, never downloaded
    ]);
    const g = groupPlans({ ...input, downloaded });
    const by = Object.fromEntries(g.flatMap((b) => b.groups.flatMap((x) => x.plans)).map((p) => [p.name, p]));
    expect(by["S-101"].version.id).toBe("v1");
    expect(by["S-101"].offline).toBe(true);
    expect(by["A-001"].offline).toBe(false);
    expect(by["A-001"].version.id).toBe("v2"); // latest synced row, for the badge only
    expect(by["L-1"].offline).toBe(false); // not in the map: nothing on the device
    expect(groupPlans(input).flatMap((b) => b.groups.flatMap((x) => x.plans)).every((p) => p.offline)).toBe(true); // demo
  });
  it("builds a version ref carrying the blob key", () => {
    const p = groupPlans(input)[1].groups[1].plans[0];
    expect(p.ref).toEqual({ planVersionId: "v1b", pdfFileId: "f1", blobKey: "blob-v1b", name: "S-101" });
  });
});

describe("anchor", () => {
  const a = { pdfFileId: "920118c4-cdb7-4148-a530-b71fe83ca142", planVersionId: "e9df4afe", page: 1, uv: [0.123456, 0.5] as [number, number] };
  it("round-trips and clamps", () => {
    const back = parseAnchor(encodeAnchor(a))!;
    expect(back.pdfFileId).toBe(a.pdfFileId);
    expect(back.uv[0]).toBeCloseTo(0.12346, 5);
    expect(parseAnchor(encodeAnchor({ ...a, uv: [-3, 9] }))!.uv).toEqual([0, 1]);
  });
  it("rejects malformed anchors", () => {
    for (const bad of [null, "", "plan~a~b~1~0.5", "x~a~b~1~0.1~0.2", "plan~a~b~0~0.1~0.2", "plan~a~b~1~2~0.5", "plan~a b~v~1~0.1~0.2", "plan~a~b~1~x~0.5", "plan~a~b~1.5~0.1~0.2"]) {
      expect(parseAnchor(bad)).toBeNull();
    }
  });
  it("builds the /tasks/new url", () => {
    expect(newTaskUrl(a)).toMatch(/^\/tasks\/new\?anchor=plan~/);
    expect(parseAnchor(decodeURIComponent(newTaskUrl(a).split("=")[1]))).not.toBeNull();
  });
});

describe("pinsForPlan", () => {
  const task = (id: string, pdf: unknown, pending = false) => ({ id, num: 1, title: id, status: 20, pending, location: { pdf } }) as unknown as PanelTask;
  it("keeps only valid pins of this plan/page and flags pending ones", () => {
    const tasks = [
      task("a", { pdfFileId: "f1", page: 1, uv: [0.5, 0.5], calibId: "c" }),
      task("b", { pdfFileId: "f1", page: 2, uv: [0.5, 0.5], calibId: "c" }),
      task("c", { pdfFileId: "other", page: 1, uv: [0.5, 0.5], calibId: "c" }),
      task("d", { pdfFileId: "f1", page: 1, uv: [1.5, 0.5], calibId: "c" }),
      task("e", { pdfFileId: "f1", page: 1, uv: [0.1, 0.9], calibId: "c" }, true),
      task("f", null),
    ];
    const pins = pinsForPlan(tasks, "f1", "v9");
    expect(pins.map((p) => p.taskId)).toEqual(["a", "e"]);
    expect(pins.find((p) => p.taskId === "e")!.pending).toBe(true);
  });
  it("separates pins of the displayed version from earlier-revision and legacy pins", () => {
    const at = (id: string, pdfVersionId?: string) =>
      task(id, { pdfFileId: "f1", page: 1, uv: [0.5, 0.5], calibId: "c", ...(pdfVersionId ? { pdfVersionId } : {}) });
    const pins = pinsForPlan([at("cur", "v9"), at("old", "v8"), at("legacy")], "f1", "v9");
    const by = Object.fromEntries(pins.map((p) => [p.taskId, p]));
    expect(by.cur.onEarlierRevision).toBe(false);
    expect(by.old.onEarlierRevision).toBe(true);
    expect(by.old.pdfVersionId).toBe("v8");
    expect(by.legacy.onEarlierRevision).toBe(true);
    expect(by.legacy.pdfVersionId).toBeUndefined();
    // after the plan is updated to v10, yesterday's current pin becomes an earlier one
    expect(pinsForPlan([at("cur", "v9")], "f1", "v10")[0].onEarlierRevision).toBe(true);
  });
});

describe("DemoPlanSource", () => {
  const ref = { planVersionId: "v", pdfFileId: "f", blobKey: "k1", name: "n" };
  it("serves from the store, else fetches the bundled sample once and persists it", async () => {
    const store = new MemoryBlobStore();
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array([37, 80, 68, 70]))) as unknown as typeof fetch;
    const src = new DemoPlanSource(store, fetchImpl);
    expect(Array.from(await src.fetchPdf(ref))).toEqual([37, 80, 68, 70]);
    expect(await store.stat(pdfKey(ref))).not.toBeNull();
    await src.fetchPdf(ref);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("prefers bytes already in the store (offline / pushed files)", async () => {
    const store = new MemoryBlobStore();
    await store.write(pdfKey(ref), new Uint8Array([1, 2, 3]));
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    expect(Array.from(await new DemoPlanSource(store, fetchImpl).fetchPdf(ref))).toEqual([1, 2, 3]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("fails loudly when neither is available", async () => {
    const src = new DemoPlanSource(new MemoryBlobStore(), (async () => new Response("", { status: 404 })) as typeof fetch);
    await expect(src.fetchPdf(ref)).rejects.toThrow(/not available offline/);
  });
});
