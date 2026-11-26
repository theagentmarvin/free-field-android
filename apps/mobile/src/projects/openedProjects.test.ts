import { describe, expect, it } from "vitest";
import { AVAILABLE_WHEN_ONLINE, markProjectOpened, pickerEntries, readOpenedProjects } from "./openedProjects";

function mem(): { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void } {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
}

describe("opened projects", () => {
  it("records per user, without duplicates", () => {
    const s = mem();
    expect(readOpenedProjects(s, "u1")).toEqual([]);
    markProjectOpened(s, "u1", "p1");
    markProjectOpened(s, "u1", "p1");
    markProjectOpened(s, "u1", "p2");
    markProjectOpened(s, "u2", "p9");
    expect(readOpenedProjects(s, "u1")).toEqual(["p1", "p2"]);
    expect(readOpenedProjects(s, "u2")).toEqual(["p9"]);
  });
  it("tolerates corrupt storage", () => {
    const s = mem();
    s.setItem("ffm-opened-projects:u1", "{not json");
    expect(readOpenedProjects(s, "u1")).toEqual([]);
    s.setItem("ffm-opened-projects:u1", '{"a":1}');
    expect(readOpenedProjects(s, "u1")).toEqual([]);
  });
});

describe("pickerEntries", () => {
  const ms = [
    { id: "a", name: "Alpha", role: "admin" },
    { id: "b", role: "member" },
  ];
  it("all available online", () => {
    const e = pickerEntries(ms, [], true);
    expect(e.every((x) => x.available)).toBe(true);
    expect(e[1].name).toBe("b");
  });
  it("offline: only previously opened projects are available", () => {
    const e = pickerEntries(ms, ["a"], false);
    expect(e[0]).toMatchObject({ available: true, reason: null });
    expect(e[1]).toMatchObject({ available: false, reason: AVAILABLE_WHEN_ONLINE });
  });
});
