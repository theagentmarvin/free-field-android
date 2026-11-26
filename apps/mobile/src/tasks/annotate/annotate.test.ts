import { describe, expect, it, vi } from "vitest";
import { canRedo, canUndo, clampPt, clearAll, commit, emptyHistory, MAX_UNDO, redo, undo, arrowHead, type Shape } from "./model";
import { drawShapes, type Ctx2D } from "./render";
import { flattenAnnotated } from "./flatten";

const rect = (id: string): Shape => ({ id, kind: "rect", color: "#f00", width: 0.01, from: [0.1, 0.1], to: [0.5, 0.5] });
const pen = (id: string): Shape => ({ id, kind: "pen", color: "#0f0", width: 0.01, points: [[0, 0], [1, 1]] });

describe("annotation history", () => {
  it("undo/redo", () => {
    let h = commit(commit(emptyHistory, rect("a")), pen("b"));
    expect(h.shapes.map((s) => s.id)).toEqual(["a", "b"]);
    h = undo(h);
    expect(h.shapes.map((s) => s.id)).toEqual(["a"]);
    expect(canRedo(h)).toBe(true);
    h = redo(h);
    expect(h.shapes).toHaveLength(2);
    expect(canRedo(h)).toBe(false);
    expect(undo(emptyHistory)).toBe(emptyHistory);
    expect(redo(emptyHistory)).toBe(emptyHistory);
  });
  it("a new shape clears the redo stack", () => {
    let h = commit(emptyHistory, rect("a"));
    h = undo(h);
    h = commit(h, pen("b"));
    expect(canRedo(h)).toBe(false);
    expect(h.shapes.map((s) => s.id)).toEqual(["b"]);
  });
  it("clear is undoable and history is capped", () => {
    let h = commit(commit(emptyHistory, rect("a")), rect("b"));
    h = clearAll(h);
    expect(h.shapes).toEqual([]);
    expect(undo(h).shapes).toHaveLength(2);
    let big = emptyHistory;
    for (let i = 0; i < MAX_UNDO + 20; i++) big = commit(big, rect(String(i)));
    expect(big.past.length).toBe(MAX_UNDO);
    expect(canUndo(big)).toBe(true);
  });
  it("clamps points and builds symmetric arrow heads", () => {
    expect(clampPt([-1, 2])).toEqual([0, 1]);
    const [a, b] = arrowHead([0, 0.5], [1, 0.5], 0.1);
    expect(a[0]).toBeCloseTo(b[0]);
    expect(a[1] + b[1]).toBeCloseTo(1);
  });
});

function fakeCtx() {
  const calls: string[] = [];
  const ctx = new Proxy({} as Record<string, unknown>, {
    get: (t, k: string) => (k in t ? t[k] : (...a: unknown[]) => void calls.push(`${k}(${a.map((x) => (typeof x === "number" ? Math.round(x) : x)).join(",")})`)),
    set: (t, k: string, v) => { t[k] = v; if (k === "strokeStyle" || k === "fillStyle") calls.push(`${k}=${v}`); return true; },
  }) as unknown as Ctx2D;
  return { ctx, calls };
}

describe("rendering and flatten", () => {
  it("draws in pixel space from normalized coordinates", () => {
    const { ctx, calls } = fakeCtx();
    drawShapes(ctx, [rect("a"), { id: "t", kind: "text", color: "#fff", size: 0.04, at: [0.5, 0.5], text: "Hi" }], 200, 100);
    expect(calls).toContain("strokeRect(20,10,80,40)");
    expect(calls).toContain("fillText(Hi,100,50)");
  });
  it("flatten downsizes to the cap and draws the shapes on the decoded bitmap, original untouched", async () => {
    const close = vi.fn();
    const original = new Blob(["orig"]);
    const seen: string[] = [];
    const out = await flattenAnnotated(original, [rect("a")], 2560, {
      decode: async () => ({ width: 5120, height: 2560, close }) as unknown as ImageBitmap,
      encode: async (_b, size, draw) => {
        const { ctx, calls } = fakeCtx();
        draw(ctx as never, size);
        seen.push(`${size.width}x${size.height}`, ...calls.filter((c) => c.startsWith("strokeRect")));
        return new Blob(["flat"], { type: "image/jpeg" });
      },
    });
    expect(seen[0]).toBe("2560x1280");
    expect(seen[1]).toBe("strokeRect(256,128,1024,512)");
    expect(await out.text()).toBe("flat");
    expect(await original.text()).toBe("orig");
    expect(close).toHaveBeenCalled();
  });
});
