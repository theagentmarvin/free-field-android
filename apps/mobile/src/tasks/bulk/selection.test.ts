import { describe, expect, it } from "vitest";
import { allSelected, clearSelection, EMPTY_SELECTION, enter, exit, prune, selectAll, selectRange, toggle } from "./selection";

describe("selection state", () => {
  const order = ["a", "b", "c", "d", "e"];
  it("a long press enters select mode with that row; Select enters empty", () => {
    const s = enter(EMPTY_SELECTION, "b");
    expect(s.active).toBe(true);
    expect([...s.ids]).toEqual(["b"]);
    expect(enter(EMPTY_SELECTION).ids.size).toBe(0);
    expect(enter(EMPTY_SELECTION).active).toBe(true);
    expect([...enter(s, "b").ids]).toEqual(["b"]); // pressing a selected row does not unselect it
  });
  it("toggle adds and removes, never mutating the previous set", () => {
    const s1 = toggle(EMPTY_SELECTION, "a");
    const s2 = toggle(s1, "b");
    const s3 = toggle(s2, "a");
    expect([...s1.ids]).toEqual(["a"]);
    expect([...s3.ids]).toEqual(["b"]);
  });
  it("select all visible replaces the selection; clear empties it but stays in select mode; exit leaves", () => {
    const s = selectAll(toggle(EMPTY_SELECTION, "zzz"), order);
    expect([...s.ids]).toEqual(order);
    expect(allSelected(s, order)).toBe(true);
    expect(allSelected(s, [])).toBe(false);
    const c = clearSelection(s);
    expect(c.ids.size).toBe(0);
    expect(c.active).toBe(true);
    expect(exit()).toEqual(EMPTY_SELECTION);
  });
  it("range selection fills between the anchor and the target in display order", () => {
    const s = selectRange(toggle(EMPTY_SELECTION, "b"), order, "d");
    expect([...s.ids].sort()).toEqual(["b", "c", "d"]);
  });
  it("prune drops rows that left the list and keeps identity when nothing changed", () => {
    const s = selectAll(EMPTY_SELECTION, order);
    expect(prune(s, order)).toBe(s);
    const p = prune(s, ["a", "c"]);
    expect([...p.ids]).toEqual(["a", "c"]);
    expect(p.active).toBe(true);
  });
});
