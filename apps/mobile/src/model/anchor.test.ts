import { describe, expect, it } from "vitest";
import type { PanelTask } from "@ff/tasks-react";
import { parseAnchor, parseNewTaskParams } from "../tasks/anchor";
import { buildBimAnchor, newTaskPathForModel, pinsForBuilding } from "./anchor";

const FILE = "662b163f-d974-46fe-b30a-227893228444";

describe("bim anchor encode/decode", () => {
  it("round-trips element, world point and camera through the new-task URL", () => {
    const path = newTaskPathForModel(
      { modelId: FILE, localId: 4821, point: [12.3456789, 3, -4.25], pose: { pos: [10, 8, 10], target: [12.3, 3, -4.2], fov: 60 } },
      "b-1",
      "Level 2",
    )!;
    expect(path.startsWith("/tasks/new?")).toBe(true);
    const params = parseNewTaskParams(new URL(path, "http://x").search);
    expect(params.buildingId).toBe("b-1");
    expect(params.storey).toBe("Level 2");
    expect(params.anchor).toEqual({
      kind: "bim",
      elements: [{ modelId: FILE, expressId: 4821 }],
      worldPoint: [12.346, 3, -4.25],
      cameraPose: { pos: [10, 8, 10], target: [12.3, 3, -4.2], fov: 60, isOrtho: false },
    });
  });

  it("accepts a point without an element and an element without a point", () => {
    expect(buildBimAnchor({ modelId: FILE, localId: null, point: [1, 2, 3] })).toMatchObject({ elements: [], worldPoint: [1, 2, 3] });
    expect(buildBimAnchor({ modelId: FILE, localId: 0, point: null })).toMatchObject({ elements: [{ modelId: FILE, expressId: 0 }], worldPoint: null });
  });

  it("refuses to pin nothing, and ids the grammar cannot carry", () => {
    expect(buildBimAnchor({ modelId: FILE, localId: null, point: null })).toBeNull();
    expect(buildBimAnchor({ modelId: FILE, localId: -1, point: null })).toBeNull();
    expect(buildBimAnchor({ modelId: "has space.ifc", localId: 3, point: [0, 0, 0] })).toBeNull();
  });

  it("emits the documented grammar", () => {
    const a = buildBimAnchor({ modelId: "m-1", localId: 7, point: [1, 2, 3], pose: { pos: [1, 1, 1], target: [0, 0, 0], fov: 45 } })!;
    const raw = new URL(newTaskPathForModel({ modelId: "m-1", localId: 7, point: [1, 2, 3], pose: { pos: [1, 1, 1], target: [0, 0, 0], fov: 45 } }, "b")!, "http://x").searchParams.get("anchor");
    expect(raw).toBe("bim:m-1.7@1,2,3~1,1,1,0,0,0,45,0");
    expect(parseAnchor(raw)).toEqual(a);
  });

  it("negative and fractional coordinates survive", () => {
    const raw = "bim:m.1@-0.5,0.001,-12~0,0,0,-1,-2,-3,60,0";
    expect(parseAnchor(raw)?.kind).toBe("bim");
  });
});

describe("pinsForBuilding", () => {
  const task = (id: string, extra: Partial<PanelTask> & { location?: unknown }) =>
    ({ id, num: 1, title: id, status: 10, updatedAt: 0, assigneeName: null, lastAction: "", entryCount: 0, ...extra }) as unknown as PanelTask;
  const loc = (modelId: string | null, wp: [number, number, number] | null) => ({
    storeyName: null,
    pdf: null,
    bim: { elements: modelId ? [{ modelId, expressId: 1 }] : [], worldPoint: wp, cameraPose: null },
  });

  it("keeps tasks of this building and ignores other buildings", () => {
    const tasks = [
      task("a", { buildingId: "b1", location: loc(FILE, [0, 0, 0]) }),
      task("b", { buildingId: "b2", location: loc(FILE, [0, 0, 0]) }),
    ];
    expect(pinsForBuilding(tasks, "b1", new Set([FILE])).map((p) => p.taskId)).toEqual(["a"]);
  });

  it("matches legacy tasks (no building) by model id and skips unpinned or plan-only tasks", () => {
    const tasks = [
      task("legacy-here", { location: loc(FILE, [1, 1, 1]) }),
      task("legacy-else", { location: loc("other-model", [1, 1, 1]) }),
      task("bare-point", { location: loc(null, [1, 1, 1]) }),
      task("no-point", { buildingId: "b1", location: loc(FILE, null) }),
      task("no-loc", { buildingId: "b1" }),
    ];
    expect(pinsForBuilding(tasks, "b1", new Set([FILE])).map((p) => p.taskId).sort()).toEqual(["bare-point", "legacy-here"]);
  });

  it("flags queued (pending) tasks", () => {
    const tasks = [task("p", { buildingId: "b1", pending: true, location: loc(FILE, [0, 0, 0]) })];
    expect(pinsForBuilding(tasks, "b1", new Set([FILE]))[0].pending).toBe(true);
  });
});
