import { describe, expect, it } from "vitest";
import { measureKey, PlanMeasureStore } from "./planMeasureStore";

function mem() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), raw: m };
}
const key = measureKey("v1");
const line = { kind: "length", points: [{ x: 0, y: 0 }, { x: 3, y: 4 }] } as const;

describe("plan measure store", () => {
  it("adds, removes and clears per plan version and persists per user", () => {
    const st = mem();
    const a = new PlanMeasureStore("u1", st);
    const m1 = a.add(key, line);
    a.add(key, { kind: "area", points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }] });
    a.add(measureKey("v2"), line);
    expect(a.list(key)).toHaveLength(2);
    expect(new PlanMeasureStore("u1", st).list(key)).toHaveLength(2);
    expect(new PlanMeasureStore("u2", st).list(key)).toHaveLength(0);
    a.remove(key, m1.id);
    expect(a.list(key).map((m) => m.kind)).toEqual(["area"]);
    a.clear(key);
    expect(a.list(key)).toEqual([]);
    expect(a.list(measureKey("v2"))).toHaveLength(1);
  });
  it("keeps the manual scale per version and page; null removes it", () => {
    const st = mem();
    const a = new PlanMeasureStore("u1", st);
    a.setScale(key, 0.02);
    expect(new PlanMeasureStore("u1", st).getSnapshot().scales[key]).toBe(0.02);
    a.setScale(key, null);
    expect(new PlanMeasureStore("u1", st).getSnapshot().scales[key]).toBeUndefined();
  });
  it("notifies subscribers and survives corrupt storage", () => {
    const st = mem();
    st.setItem("ffm.planMeasure.v1.u1", "{not json");
    const a = new PlanMeasureStore("u1", st);
    let n = 0;
    const off = a.subscribe(() => n++);
    a.add(key, line);
    off();
    a.add(key, line);
    expect(n).toBe(1);
    st.setItem("ffm.planMeasure.v1.u3", JSON.stringify({ measurements: { [key]: [{ id: "x", kind: "length", points: [{ x: "a", y: 1 }] }, { id: "y", kind: "bogus", points: [] }] }, scales: { [key]: -1 } }));
    const b = new PlanMeasureStore("u3", st);
    expect(b.list(key)).toEqual([]);
    expect(b.getSnapshot().scales).toEqual({});
  });
});
