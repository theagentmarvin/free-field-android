import { describe, expect, it } from "vitest";
import { DEMO_ACTOR_NAME, resolveActor } from "./identity";

describe("resolveActor", () => {
  it("demo: one persona for both demo roles, never the role's email", () => {
    for (const email of ["guest@demo", "admin@demo"]) {
      expect(resolveActor({ demo: true, uid: "demo-viewer", email, hookName: "Alex Rivera" })).toEqual({ uid: "demo-viewer", name: DEMO_ACTOR_NAME });
    }
  });
  it("real: the profile display name wins", () => {
    expect(resolveActor({ demo: false, uid: "u1", email: "a@b.c", hookName: "Ana Silva" }).name).toBe("Ana Silva");
  });
  it("real: falls back to the email, then the uid", () => {
    expect(resolveActor({ demo: false, uid: "u1", email: "a@b.c", hookName: "me" }).name).toBe("a@b.c");
    expect(resolveActor({ demo: false, uid: "u1", email: "a@b.c", hookName: "  " }).name).toBe("a@b.c");
    expect(resolveActor({ demo: false, uid: "u1", email: null, hookName: null }).name).toBe("u1");
  });
});
