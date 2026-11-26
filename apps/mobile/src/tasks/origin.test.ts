import { describe, expect, it } from "vitest";
import { newTaskExit } from "./origin";
import { buildNewTaskPath } from "./anchor";
import { newTaskUrl } from "../plans/anchor";
import { newTaskPathForModel } from "../model/anchor";

const search = (path: string) => path.slice(path.indexOf("?"));

describe("newTaskExit", () => {
  it("the Tasks tab returns to the list and opens the new task on save", () => {
    const x = newTaskExit("");
    expect(x.origin).toBe("tasks");
    expect(x.cancelTo).toBe("/tasks");
    expect(x.saveTo("abc")).toBe("/tasks/abc");
    expect(newTaskExit(search(buildNewTaskPath({ draftId: "d1" }))).cancelTo).toBe("/tasks");
  });

  it("a plan pin returns to that plan for both cancel and save", () => {
    const x = newTaskExit(search(newTaskUrl({ pdfFileId: "pdf-1", planVersionId: "v1", page: 1, uv: [0.2, 0.3] })));
    expect(x.origin).toBe("plan");
    expect(x.cancelTo).toBe("/plans/pdf-1");
    expect(x.saveTo("abc")).toBe("/plans/pdf-1");
  });

  it("a 3D pin returns to its building and focuses the new pin on save", () => {
    const path = newTaskPathForModel({ modelId: "m1", localId: 7, point: [1, 2, 3], pose: null }, "b-1", "L1")!;
    const x = newTaskExit(search(path));
    expect(x.origin).toBe("model");
    expect(x.cancelTo).toBe("/model/b-1");
    expect(x.saveTo("abc")).toBe("/model/b-1?task=abc");
  });
});
