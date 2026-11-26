import { AUTO_FINISH_POINTS, MIN_POINTS, type PlanMeasureKind } from "./planMath";
import type { Point } from "./webMath";

export type PlanTool = "none" | PlanMeasureKind | "scale";

export interface Draft {
  tool: PlanTool;
  points: Point[];
}

export type DraftResult =
  | { type: "draft"; draft: Draft }
  /** A measurement is complete (angles on the third point, or Finish). */
  | { type: "done"; kind: PlanMeasureKind; points: Point[]; draft: Draft }
  /** The scale tool has its two points: ask for the real length. */
  | { type: "scale"; a: Point; b: Point; draft: Draft };

export const emptyDraft = (tool: PlanTool): Draft => ({ tool, points: [] });

/** A placed point. A point on top of the last one (double tap) is ignored. */
export function addPoint(d: Draft, p: Point, minGap = 0): DraftResult {
  if (d.tool === "none") return { type: "draft", draft: d };
  const last = d.points[d.points.length - 1];
  if (last && Math.hypot(last.x - p.x, last.y - p.y) <= minGap) return { type: "draft", draft: d };
  const points = [...d.points, p];
  if (d.tool === "scale") {
    if (points.length === 2) return { type: "scale", a: points[0], b: points[1], draft: emptyDraft("scale") };
    return { type: "draft", draft: { tool: "scale", points } };
  }
  const auto = AUTO_FINISH_POINTS[d.tool];
  if (auto !== undefined && points.length >= auto) return { type: "done", kind: d.tool, points, draft: emptyDraft(d.tool) };
  return { type: "draft", draft: { ...d, points } };
}

export function undoPoint(d: Draft): Draft {
  return { ...d, points: d.points.slice(0, -1) };
}

export function canFinish(d: Draft): boolean {
  return d.tool !== "none" && d.tool !== "scale" && d.points.length >= MIN_POINTS[d.tool];
}

/** Finish: commit the draft when it has enough points. */
export function finishDraft(d: Draft): DraftResult | null {
  if (!canFinish(d) || d.tool === "none" || d.tool === "scale") return null;
  return { type: "done", kind: d.tool, points: d.points, draft: emptyDraft(d.tool) };
}

/** Cancel: drop the draft; with nothing drafted, leave the tool. */
export function cancelDraft(d: Draft): Draft {
  return d.points.length > 0 ? emptyDraft(d.tool) : emptyDraft("none");
}

/** Switching tool discards a draft in progress. */
export function selectTool(tool: PlanTool): Draft {
  return emptyDraft(tool);
}
