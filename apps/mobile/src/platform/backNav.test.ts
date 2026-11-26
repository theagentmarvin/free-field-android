import { describe, expect, it } from "vitest";
import { decideBack, parentRoute } from "./backNav";

describe("decideBack", () => {
  it("goes back through in-app history first", () => {
    expect(decideBack("/tasks/new", 3)).toEqual({ type: "history" });
    expect(decideBack("/tasks", 1)).toEqual({ type: "history" });
  });
  it("climbs to the parent screen when the history index is 0 or unknown", () => {
    expect(decideBack("/tasks/new", 0)).toEqual({ type: "navigate", to: "/tasks" });
    expect(decideBack("/tasks/abc", null)).toEqual({ type: "navigate", to: "/tasks" });
    expect(decideBack("/tasks/abc/edit", undefined)).toEqual({ type: "navigate", to: "/tasks/abc" });
    expect(decideBack("/tasks/abc/markup", 0)).toEqual({ type: "navigate", to: "/tasks/abc" });
    expect(decideBack("/offline", 0)).toEqual({ type: "navigate", to: "/more" });
    expect(decideBack("/plans/f1", 0)).toEqual({ type: "navigate", to: "/plans" });
    expect(decideBack("/model/b1", null)).toEqual({ type: "navigate", to: "/model" });
  });
  it("sends the root of another tab to the home tab", () => {
    for (const p of ["/plans", "/model", "/sync", "/more", "/something-else"]) expect(decideBack(p, 0)).toEqual({ type: "navigate", to: "/tasks" });
  });
  it("exits only from the root of the home tab with no history", () => {
    expect(decideBack("/tasks", 0)).toEqual({ type: "exit" });
    expect(decideBack("/tasks/", null)).toEqual({ type: "exit" });
  });
  it("never exits while a nested screen or history remains", () => {
    for (const p of ["/tasks/new", "/tasks/x", "/tasks/x/edit", "/offline", "/plans/x", "/plans", "/more"]) {
      expect(decideBack(p, 0).type).not.toBe("exit");
      expect(decideBack(p, 2).type).toBe("history");
    }
  });
  it("tab roots have no parent", () => {
    for (const p of ["/tasks", "/plans", "/model", "/sync", "/more"]) expect(parentRoute(p)).toBeNull();
  });
});
