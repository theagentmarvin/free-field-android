import type { MeasureVariant } from "@ff/viewer-react";

export const VARIANTS: Array<{ id: MeasureVariant; label: string }> = [
  { id: "length", label: "Length" },
  { id: "area", label: "Area" },
  { id: "angle", label: "Angle" },
  { id: "volume", label: "Volume" },
];

/** Points after which the engine completes the measurement itself (length, angle); area and volume need Finish. */
export const AUTO_POINTS: Partial<Record<MeasureVariant, number>> = { length: 2, angle: 3 };
export const MIN_FINISH: Partial<Record<MeasureVariant, number>> = { area: 3, volume: 1 };

export function canFinish3d(variant: MeasureVariant, placed: number): boolean {
  const need = MIN_FINISH[variant];
  return need !== undefined && placed >= need;
}

export function hintFor(variant: MeasureVariant, placed: number): string {
  switch (variant) {
    case "length":
      return placed === 0 ? "Set the first point" : "Set the second point";
    case "angle":
      return placed === 0 ? "Set the first point" : placed === 1 ? "Set the corner point" : "Set the third point";
    case "area":
      return placed === 0 ? "Set the first corner" : placed < 3 ? `Set corner ${placed + 1} (3 needed)` : "Add corners, then Finish";
    case "volume":
      return placed === 0 ? "Tap an element to measure its volume" : "Add elements or Finish";
  }
}

/** Points placed on the in-progress measurement (world positions), so Undo can rebuild all but the last. */
export class PlacedPoints<P> {
  private pts: P[] = [];
  constructor(private readonly variant: MeasureVariant) {}

  get count(): number {
    return this.pts.length;
  }
  push(p: P): void {
    this.pts.push(p);
  }
  /** True when the engine has just completed the measurement (length, angle): the draft is over. */
  completed(): boolean {
    const auto = AUTO_POINTS[this.variant];
    return auto !== undefined && this.pts.length >= auto;
  }
  /** Drop the last point; returns the points to replay after the engine's draft was cancelled. */
  undo(): P[] {
    this.pts.pop();
    return [...this.pts];
  }
  reset(): void {
    this.pts = [];
  }
}
