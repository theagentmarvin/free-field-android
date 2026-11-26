import { describe, expect, it } from "vitest";
import { parseTapExtra } from "./platform";
import { resolveTap } from "./tapRoute";

const M = [{ id: "a" }, { id: "b" }];
const tap = (projectId: string | null) => ({ path: "/tasks/t1", projectId });

describe("resolveTap", () => {
  it("opens directly in the current project", () => {
    expect(resolveTap(tap("a"), "a", M)).toEqual({ kind: "open", path: "/tasks/t1" });
  });
  it("opens directly for an old notification without a project", () => {
    expect(resolveTap(tap(null), "a", M)).toEqual({ kind: "open", path: "/tasks/t1" });
  });
  it("switches first when another project the user belongs to is current", () => {
    expect(resolveTap(tap("b"), "a", M)).toEqual({ kind: "switch", projectId: "b", path: "/tasks/t1" });
    expect(resolveTap(tap("b"), null, M)).toMatchObject({ kind: "switch", projectId: "b" });
  });
  it("reports a project the user left", () => {
    expect(resolveTap(tap("gone"), "a", M)).toEqual({ kind: "not-member" });
  });
  it("waits while memberships load", () => {
    expect(resolveTap(tap("b"), undefined, undefined)).toEqual({ kind: "wait" });
  });
});

describe("parseTapExtra", () => {
  it("reads path and project", () => {
    expect(parseTapExtra({ path: "/tasks", projectId: "p" })).toEqual({ path: "/tasks", projectId: "p" });
    expect(parseTapExtra({ path: "/tasks" })).toEqual({ path: "/tasks", projectId: null });
  });
  it("rejects bad routes", () => {
    expect(parseTapExtra({ path: "tasks" })).toBeNull();
    expect(parseTapExtra(undefined)).toBeNull();
  });
});
