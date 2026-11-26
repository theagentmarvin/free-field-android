import { buildActionPayload, sha256Hex, type TaskActionPayload, type TaskEntryView, type TaskStatus } from "@ff/tasks";
import { registerBlob, releaseBlob } from "@ff/tasks-react";

/**
 * A task markup is a task ATTACHMENT: one picture (the captured view with the drawing burned in) carried by a `comment`
 * action, so it rides the very same offline outbox, blob store and upload path as the photos of a comment. Nothing in the
 * shared task schema or the rules changes. Two timeline entries carry the meaning, told apart by a short tag at the start of
 * the entry text (readable on any client: the web shows them as an ordinary comment with a picture):
 *
 *   `[markup] Markup added`                         one picture = one markup
 *   `[markup-removed:<12 hex>] Markup removed`      hides the markup whose picture path carries that 12-hex sha prefix
 *
 * A markup is fixed: it is never edited, only viewed and removed.
 */
export const MARKUP_ADDED_TEXT = "[markup] Markup added";
export const markupRemovedText = (key: string) => `[markup-removed:${key}] Markup removed`;

const ADDED = /^\[markup\](?:\s|$)/;
const REMOVED = /^\[markup-removed:([0-9a-f]{12})\](?:\s|$)/;
const PATH_KEY = /\/([0-9a-f]{12})-\d+\.[a-z0-9]+$/i;

export type MarkupTag = { kind: "added" } | { kind: "removed"; key: string } | null;

export function parseMarkupText(text: string | null | undefined): MarkupTag {
  const t = text ?? "";
  const rem = REMOVED.exec(t);
  if (rem) return { kind: "removed", key: rem[1] };
  return ADDED.test(t) ? { kind: "added" } : null;
}

/** The 12-hex sha prefix a picture's Storage path is named with (the identity of a markup), or null. */
export function markupKeyOfPath(path: string | null | undefined): string | null {
  const m = PATH_KEY.exec(path ?? "");
  return m ? m[1].toLowerCase() : null;
}

export interface MarkupAttachment {
  /** timeline entry (client guid) */
  id: string;
  /** Storage path of the picture (also what a queued blob is looked up by) */
  path: string;
  key: string;
  at: number;
  by: string;
  pending: boolean;
  failed: boolean;
}

export interface MarkupDerived {
  /** live markups, oldest first */
  markups: MarkupAttachment[];
  /** entry ids that are markup entries (added or removed), for the timeline */
  markupEntries: Map<string, { kind: "added" | "removed"; removed: boolean }>;
}

/** Fold the timeline into the task's live markups. `pathsOf` is the detail hook's `entryPaths`. */
export function deriveMarkups(entries: readonly TaskEntryView[], pathsOf: (e: TaskEntryView) => string[]): MarkupDerived {
  const removedKeys = new Set<string>();
  for (const e of entries) {
    const tag = e.action === "comment" ? parseMarkupText(e.text) : null;
    if (tag?.kind === "removed") removedKeys.add(tag.key);
  }
  const markups: MarkupAttachment[] = [];
  const markupEntries = new Map<string, { kind: "added" | "removed"; removed: boolean }>();
  for (const e of entries) {
    if (e.action !== "comment") continue;
    const tag = parseMarkupText(e.text);
    if (!tag) continue;
    if (tag.kind === "removed") {
      markupEntries.set(e.id, { kind: "removed", removed: true });
      continue;
    }
    const path = pathsOf(e)[0];
    const key = markupKeyOfPath(path);
    if (!path || !key) {
      markupEntries.set(e.id, { kind: "added", removed: false });
      continue;
    }
    const removed = removedKeys.has(key);
    markupEntries.set(e.id, { kind: "added", removed });
    if (!removed) markups.push({ id: e.id, path, key, at: e.at, by: e.by, pending: !!e.pending, failed: !!e.failed });
  }
  markups.sort((a, b) => a.at - b.at);
  return { markups, markupEntries };
}

export interface MarkupEngine {
  enqueue(payload: TaskActionPayload): Promise<unknown>;
}

export interface MarkupContext {
  engine: MarkupEngine;
  projectId: string;
  taskId: string;
  title: string;
  statusFrom: TaskStatus;
  actor: { uid: string; name: string };
}

export interface MarkupSaveDeps {
  register(key: string, blob: Blob): void;
  release(key: string): void;
  sha256(bytes: ArrayBuffer): Promise<string>;
  newId(): string;
}

const realDeps = (): MarkupSaveDeps => ({
  register: registerBlob,
  release: releaseBlob,
  sha256: sha256Hex,
  newId: () => crypto.randomUUID().replace(/-/g, "").slice(0, 12),
});

/**
 * Save the flattened picture as a task attachment: the bytes go to the durable blob store the outbox reads from, then ONE
 * `comment` action is queued (it uploads the picture first, then writes the timeline entry, exactly like a comment photo).
 * Works offline: the action waits in the outbox. A failed enqueue drops the blob again.
 */
export async function saveMarkup(ctx: MarkupContext, picture: Blob, deps: MarkupSaveDeps = realDeps()): Promise<{ key: string; blobKey: string }> {
  const mime = picture.type || "image/jpeg";
  const sha256 = await deps.sha256(await picture.arrayBuffer());
  const blobKey = `${ctx.taskId}-mk-${deps.newId()}`;
  deps.register(blobKey, picture);
  try {
    await ctx.engine.enqueue(
      buildActionPayload({
        verb: "comment",
        projectId: ctx.projectId,
        taskId: ctx.taskId,
        statusFrom: ctx.statusFrom,
        actor: ctx.actor,
        title: ctx.title,
        text: MARKUP_ADDED_TEXT,
        photoRefs: [{ blobKey, sha256, size: picture.size, mime }],
      }),
    );
  } catch (e) {
    deps.release(blobKey);
    throw e;
  }
  return { key: sha256.slice(0, 12), blobKey };
}

/** Remove a markup (after the user confirmed): a tombstone entry, also queued offline. The picture file stays in Storage. */
export async function removeMarkup(ctx: MarkupContext, key: string): Promise<void> {
  await ctx.engine.enqueue(
    buildActionPayload({
      verb: "comment",
      projectId: ctx.projectId,
      taskId: ctx.taskId,
      statusFrom: ctx.statusFrom,
      actor: ctx.actor,
      title: ctx.title,
      text: markupRemovedText(key),
    }),
  );
}
