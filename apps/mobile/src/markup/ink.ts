import type { PlanMarkupKind, PlanMarkupShape } from "@ff/types";
import type { WidthPreset } from "./geometry";

/** One drawn item of the picture being annotated (in-memory only; the picture is flattened on Accept). */
export interface Ink {
  id: string;
  kind: PlanMarkupKind;
  /** `#rrggbb` */
  color: string;
  /** Fraction of the picture WIDTH (highlighter already widened). */
  strokeWidth: number;
  shape: PlanMarkupShape;
}

/**
 * Width presets for annotating a photo-like picture. They are larger than the plan presets: ink on a camera-like image has
 * to read on a phone-sized thumbnail too.
 */
export const INK_PRESETS: readonly WidthPreset[] = [
  { id: "thin", label: "Thin", stroke: 0.003, text: 0.022 },
  { id: "medium", label: "Medium", stroke: 0.0055, text: 0.032 },
  { id: "thick", label: "Thick", stroke: 0.01, text: 0.046 },
];

export const HISTORY_LIMIT = 200;

/**
 * Undo / redo of the drawing session. Strokes are only ever added, so the stack is the list: undo takes the newest item off,
 * redo puts it back, and drawing anew drops the redo stack. `getVersion` / `subscribe` feed `useSyncExternalStore`.
 */
export class InkHistory {
  private list: Ink[] = [];
  private redoStack: Ink[] = [];
  private listeners = new Set<() => void>();
  private version = 0;

  get items(): readonly Ink[] {
    return this.list;
  }
  get count(): number {
    return this.list.length;
  }
  get canUndo(): boolean {
    return this.list.length > 0;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }
  getVersion = (): number => this.version;
  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  private bump() {
    this.version++;
    for (const l of this.listeners) l();
  }

  add(ink: Ink): void {
    this.list = [...this.list, ink].slice(-HISTORY_LIMIT);
    this.redoStack = [];
    this.bump();
  }
  undo(): boolean {
    const last = this.list[this.list.length - 1];
    if (!last) return false;
    this.list = this.list.slice(0, -1);
    this.redoStack.push(last);
    this.bump();
    return true;
  }
  redo(): boolean {
    const next = this.redoStack.pop();
    if (!next) return false;
    this.list = [...this.list, next];
    this.bump();
    return true;
  }
  clear(): void {
    this.list = [];
    this.redoStack = [];
    this.bump();
  }
}
