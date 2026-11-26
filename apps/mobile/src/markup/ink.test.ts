import { describe, expect, it, vi } from "vitest";
import { INK_PRESETS, InkHistory, HISTORY_LIMIT, type Ink } from "./ink";

const ink = (id: string): Ink => ({ id, kind: "pen", color: "#dc2626", strokeWidth: 0.005, shape: { pts: [[0.1, 0.1], [0.2, 0.2]] } });

describe("InkHistory", () => {
  it("adds, undoes and redoes in order", () => {
    const h = new InkHistory();
    expect([h.canUndo, h.canRedo, h.count]).toEqual([false, false, 0]);
    h.add(ink("a"));
    h.add(ink("b"));
    expect(h.items.map((i) => i.id)).toEqual(["a", "b"]);
    expect(h.undo()).toBe(true);
    expect(h.items.map((i) => i.id)).toEqual(["a"]);
    expect(h.canRedo).toBe(true);
    expect(h.redo()).toBe(true);
    expect(h.items.map((i) => i.id)).toEqual(["a", "b"]);
    expect(h.canRedo).toBe(false);
  });
  it("a new stroke drops the redo stack", () => {
    const h = new InkHistory();
    h.add(ink("a"));
    h.undo();
    h.add(ink("b"));
    expect(h.canRedo).toBe(false);
    expect(h.redo()).toBe(false);
    expect(h.items.map((i) => i.id)).toEqual(["b"]);
  });
  it("undo and redo on empty stacks do nothing", () => {
    const h = new InkHistory();
    expect(h.undo()).toBe(false);
    expect(h.redo()).toBe(false);
  });
  it("notifies subscribers and bumps the version", () => {
    const h = new InkHistory();
    const l = vi.fn();
    const off = h.subscribe(l);
    const v0 = h.getVersion();
    h.add(ink("a"));
    h.undo();
    h.redo();
    expect(l).toHaveBeenCalledTimes(3);
    expect(h.getVersion()).toBe(v0 + 3);
    off();
    h.clear();
    expect(l).toHaveBeenCalledTimes(3);
    expect(h.count).toBe(0);
  });
  it("keeps only the newest items past the limit", () => {
    const h = new InkHistory();
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) h.add(ink(String(i)));
    expect(h.count).toBe(HISTORY_LIMIT);
    expect(h.items[h.count - 1].id).toBe(String(HISTORY_LIMIT + 4));
  });
});

describe("INK_PRESETS", () => {
  it("grow from thin to thick for strokes and text", () => {
    const [a, b, c] = INK_PRESETS;
    expect(a.stroke < b.stroke && b.stroke < c.stroke).toBe(true);
    expect(a.text < b.text && b.text < c.text).toBe(true);
  });
});
