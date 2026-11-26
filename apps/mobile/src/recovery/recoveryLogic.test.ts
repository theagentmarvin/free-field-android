import { describe, expect, it } from "vitest";
import { CRASH_NOTICE, decideRecovery, isHeavyRoute, LOOP_NOTICE, MEMORY_NOTICE, pressureForTrim, pressureFromHeap, sanitizeRoute } from "./recoveryLogic";

describe("decideRecovery", () => {
  it("does nothing when the renderer did not die", () => {
    expect(decideRecovery({ gone: false, crashed: false, recent: 0 }, "/model")).toEqual({ route: null, notice: null, loopBroken: false });
  });
  it("reopens the last route with the memory notice", () => {
    expect(decideRecovery({ gone: true, crashed: false, recent: 1 }, "/model/b1")).toEqual({ route: "/model/b1", notice: MEMORY_NOTICE, loopBroken: false });
    expect(MEMORY_NOTICE).toBe("Reloaded the 3D view after running out of memory");
  });
  it("uses the crash wording for a crash", () => {
    expect(decideRecovery({ gone: true, crashed: true, recent: 1 }, "/tasks").notice).toBe(CRASH_NOTICE);
  });
  it("breaks a kill loop on the 3D route but not on other routes", () => {
    expect(decideRecovery({ gone: true, crashed: false, recent: 3 }, "/model")).toEqual({ route: "/plans", notice: LOOP_NOTICE, loopBroken: true });
    expect(decideRecovery({ gone: true, crashed: false, recent: 5 }, "/tasks/t1").route).toBe("/tasks/t1");
  });
  it("falls back to tasks for a missing or hostile route", () => {
    expect(decideRecovery({ gone: true, crashed: false, recent: 1 }, null).route).toBe("/tasks");
    expect(sanitizeRoute("//evil.example")).toBe("/tasks");
    expect(sanitizeRoute("javascript:alert(1)")).toBe("/tasks");
    expect(sanitizeRoute("/x".repeat(400))).toBe("/tasks");
  });
  it("knows the heavy routes", () => {
    expect(isHeavyRoute("/model")).toBe(true);
    expect(isHeavyRoute("/model/b1")).toBe(true);
    expect(isHeavyRoute("/models")).toBe(false);
  });
});

describe("memory pressure", () => {
  it("maps trim levels", () => {
    expect(pressureForTrim(5)).toBe("none");
    expect(pressureForTrim(10)).toBe("low");
    expect(pressureForTrim(15)).toBe("critical");
    expect(pressureForTrim(20)).toBe("critical");
    expect(pressureForTrim(80)).toBe("critical");
  });
  it("heap heuristic has hysteresis", () => {
    expect(pressureFromHeap({ usedMb: 100, limitMb: 1000 }, "none")).toBe("none");
    expect(pressureFromHeap({ usedMb: 720, limitMb: 1000 }, "none")).toBe("low");
    expect(pressureFromHeap({ usedMb: 650, limitMb: 1000 }, "low")).toBe("low");
    expect(pressureFromHeap({ usedMb: 550, limitMb: 1000 }, "low")).toBe("none");
    expect(pressureFromHeap({ usedMb: 900, limitMb: 1000 }, "none")).toBe("critical");
    expect(pressureFromHeap({ usedMb: 800, limitMb: 1000 }, "critical")).toBe("critical");
    expect(pressureFromHeap(null, "low")).toBe("low");
  });
});
