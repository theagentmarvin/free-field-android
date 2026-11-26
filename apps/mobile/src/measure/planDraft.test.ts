import { describe, expect, it } from "vitest";
import { addPoint, canFinish, cancelDraft, emptyDraft, finishDraft, selectTool, undoPoint } from "./planDraft";

const P = (x: number, y = 0) => ({ x, y });

describe("plan draft state machine", () => {
  it("length: needs two points, Finish commits, the draft is reset", () => {
    let d = selectTool("length");
    let r = addPoint(d, P(0));
    expect(r.type).toBe("draft");
    d = (r as { draft: typeof d }).draft;
    expect(canFinish(d)).toBe(false);
    expect(finishDraft(d)).toBeNull();
    d = (addPoint(d, P(10)) as { draft: typeof d }).draft;
    d = (addPoint(d, P(10, 10)) as { draft: typeof d }).draft;
    expect(canFinish(d)).toBe(true);
    r = finishDraft(d)!;
    expect(r).toMatchObject({ type: "done", kind: "length" });
    expect((r as { points: unknown[] }).points).toHaveLength(3);
    expect((r as { draft: { points: unknown[] } }).draft.points).toEqual([]);
  });
  it("area needs three points", () => {
    let d = selectTool("area");
    d = (addPoint(d, P(0)) as { draft: typeof d }).draft;
    d = (addPoint(d, P(5)) as { draft: typeof d }).draft;
    expect(canFinish(d)).toBe(false);
    d = (addPoint(d, P(5, 5)) as { draft: typeof d }).draft;
    expect(canFinish(d)).toBe(true);
  });
  it("angle finishes itself on the third point", () => {
    let d = selectTool("angle");
    d = (addPoint(d, P(1)) as { draft: typeof d }).draft;
    d = (addPoint(d, P(0)) as { draft: typeof d }).draft;
    const r = addPoint(d, P(0, 1));
    expect(r).toMatchObject({ type: "done", kind: "angle" });
  });
  it("scale: two points hand over to the length dialog", () => {
    let d = selectTool("scale");
    d = (addPoint(d, P(0)) as { draft: typeof d }).draft;
    const r = addPoint(d, P(100, 0));
    expect(r).toMatchObject({ type: "scale", a: P(0), b: P(100, 0) });
    expect(canFinish(selectTool("scale"))).toBe(false);
  });
  it("ignores a point on top of the last one and does nothing without a tool", () => {
    let d = selectTool("length");
    d = (addPoint(d, P(0), 3) as { draft: typeof d }).draft;
    const r = addPoint(d, P(1), 3);
    expect((r as { draft: typeof d }).draft.points).toHaveLength(1);
    expect(addPoint(emptyDraft("none"), P(0)).type).toBe("draft");
  });
  it("undo removes the last point; cancel clears, then leaves the tool", () => {
    let d = selectTool("length");
    d = (addPoint(d, P(0)) as { draft: typeof d }).draft;
    d = (addPoint(d, P(4)) as { draft: typeof d }).draft;
    expect(undoPoint(d).points).toEqual([P(0)]);
    expect(undoPoint(emptyDraft("length")).points).toEqual([]);
    const c1 = cancelDraft(d);
    expect(c1).toEqual({ tool: "length", points: [] });
    expect(cancelDraft(c1)).toEqual({ tool: "none", points: [] });
  });
});
