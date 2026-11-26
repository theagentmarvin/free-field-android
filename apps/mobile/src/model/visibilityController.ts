import type { FragmentsModel } from "@thatopen/fragments";
import { computeHidden, ghostSolid, INITIAL_VIS, planApply, visReduce, type Hidden, type VisAction, type VisState } from "./visibility";
import type { ModelIndex } from "./modelIndex";

/** The opacity of x-rayed ("ghosted") elements. */
export const GHOST_OPACITY = 0.12;

export interface ViewerVisibility {
  setElementVisibility(modelId: string, ids: ReadonlySet<number>, visible: boolean): void;
  requestRender?: (reason?: string) => void;
}

interface Deps {
  viewer: () => ViewerVisibility | null;
  models: () => ReadonlyMap<string, FragmentsModel>;
  index: ModelIndex;
  /** called after every applied change, with the new state */
  onChange: (state: VisState) => void;
}

/**
 * Applies the visibility machine to the engine. All visibility goes through the viewer's `setElementVisibility` (the same
 * path as the storey isolation) so the viewer's hidden-element tracker, which keeps hidden elements out of every pick, stays
 * in sync; the raycast used by taps skips hidden items too. Only the delta against what was applied last is sent, and
 * changes are serialised: a slow category load never reorders two quick taps.
 */
export class VisibilityController {
  state: VisState = INITIAL_VIS;
  private applied = new Map<string, Hidden>();
  private ghosted = new Map<string, boolean>();
  private queue: Promise<void> = Promise.resolve();
  private dead = false;

  constructor(private readonly d: Deps) {}

  /** The hidden set last applied to a model (what the tree checkboxes show). */
  hidden(modelId: string): Hidden | undefined {
    return this.applied.get(modelId);
  }

  dispatch(action: VisAction): Promise<void> {
    this.state = visReduce(this.state, action);
    const snapshot = this.state;
    this.queue = this.queue.then(() => this.apply(snapshot)).catch((e) => console.warn("[model] visibility apply failed", e));
    return this.queue;
  }

  /** Re-apply the current state (a model finished loading after the state was set). */
  refresh(): Promise<void> {
    const snapshot = this.state;
    this.queue = this.queue.then(() => this.apply(snapshot)).catch((e) => console.warn("[model] visibility refresh failed", e));
    return this.queue;
  }

  /** The viewer was rebuilt (reload): nothing of the old world is hidden any more. */
  reset(): void {
    this.state = INITIAL_VIS;
    this.applied.clear();
    this.ghosted.clear();
    this.queue = Promise.resolve();
    this.d.onChange(this.state);
  }

  dispose(): void {
    this.dead = true;
  }

  private async apply(s: VisState): Promise<void> {
    const v = this.d.viewer();
    if (!v || this.dead) return;
    const withCats = s.hiddenCategories.size > 0;
    for (const modelId of this.d.index.modelIds()) {
      if (this.dead) return;
      const prev = this.applied.get(modelId);
      const needsUniverse = withCats || s.isolated || s.storey || s.hiddenModels.has(modelId) || prev?.all || s.hiddenIds.size > 0 || s.forced.size > 0 || (prev?.ids.size ?? 0) > 0;
      const u = needsUniverse ? await this.d.index.universe(modelId, withCats) : { all: new Set<number>(), categories: new Map<string, Uint32Array>() };
      const all = u.all instanceof Set ? u.all : new Set(u.all);
      const next = computeHidden(s, modelId, u);
      // ids of the state that the model does not have (a tree node's spatial containers) must not reach the engine
      if (!next.all) for (const id of next.ids) if (!all.has(id)) next.ids.delete(id);
      for (const op of planApply(prev, next)) {
        if (op.op === "hideAll") v.setElementVisibility(modelId, all, false);
        else if (op.op === "showAll") v.setElementVisibility(modelId, all, true);
        else v.setElementVisibility(modelId, new Set(op.ids), op.op === "show");
      }
      this.applied.set(modelId, next);
      // A hidden model is also taken out of the draw loop (no draw calls for its tiles); the items stay hidden too, so nothing in it can be picked.
      const obj = this.d.models().get(modelId)?.object;
      if (obj) obj.visible = !next.all;
      await this.applyGhost(s, modelId, all);
    }
    v.requestRender?.("tools-visibility");
    this.d.onChange(s);
  }

  /** X-ray: everything except the solid set is drawn at {@link GHOST_OPACITY}. Opacity is per item in the worker: no geometry is copied. */
  private async applyGhost(s: VisState, modelId: string, all: Set<number>): Promise<void> {
    const model = this.d.models().get(modelId);
    if (!model) return;
    const solid = ghostSolid(s, modelId);
    const was = this.ghosted.get(modelId) ?? false;
    if (solid === null) {
      if (was) {
        await model.resetOpacity(undefined);
        this.ghosted.set(modelId, false);
      }
      return;
    }
    await model.setOpacity(undefined, GHOST_OPACITY);
    const keep = [...solid].filter((id) => all.has(id));
    if (keep.length) await model.resetOpacity(keep);
    this.ghosted.set(modelId, true);
  }
}
