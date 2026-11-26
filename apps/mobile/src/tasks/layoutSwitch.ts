/**
 * Rotating a tablet across the split-view breakpoint moves the task form to a different place in the React tree, so it
 * remounts: the new form renders BEFORE the old one's cleanup runs. The open create form therefore registers its draft id
 * while mounted; a form that mounts right after a layout switch adopts it and reloads the draft instead of starting an
 * empty one (BUG-08). The unmounting form publishes its last save so the reload sees it.
 */
const WINDOW_MS = 3000;
let switchedAt = 0;
let active: { search: string; draftId: string } | null = null;
const pendingSave = new Map<string, Promise<unknown>>();

/** Called when the viewport crosses the breakpoint (before React re-renders). */
export function markLayoutSwitch(now = Date.now()): void {
  switchedAt = now;
}

/** A mounted create form announces its draft id. */
export function registerCreateForm(search: string, draftId: string): void {
  active = { search, draftId };
}

/** The create form unmounted: `saved` is its final autosave, or null when it was submitted/discarded. */
export function releaseCreateForm(draftId: string, saved: Promise<unknown> | null): void {
  if (active?.draftId === draftId) active = null;
  if (saved) pendingSave.set(draftId, saved);
  else pendingSave.delete(draftId);
}

/** A mounting create form without an explicit draft id: continue the one a layout switch just unmounted. */
export function takeParkedDraft(search: string, now = Date.now()): string | null {
  if (!active || active.search !== search || now - switchedAt > WINDOW_MS) return null;
  const id = active.draftId;
  active = null;
  return id;
}

/** Resolves when the unmounted form's last save has landed, so the reload sees it. */
export async function parkedDraftSaved(draftId: string): Promise<void> {
  await pendingSave.get(draftId)?.catch(() => undefined);
  pendingSave.delete(draftId);
}

export function resetLayoutSwitch(): void {
  switchedAt = 0;
  active = null;
  pendingSave.clear();
}
