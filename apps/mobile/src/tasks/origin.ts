import { parseNewTaskParams } from "./anchor";

/**
 * Where the dedicated New task screen came from, derived from the URL it was opened with (every entry point opens
 * `/tasks/new`): a plan long-press or markup carries a plan anchor, a 3D long-press a model anchor, the Tasks tab and the
 * Drafts folder carry neither. Cancel and Save go back there; the router history is only a hint (Back through history when it
 * exists), so a screen restored after the app was killed still has somewhere to go.
 */
export type NewTaskOrigin = "plan" | "model" | "tasks";

export interface NewTaskExit {
  origin: NewTaskOrigin;
  /** Cancel, Close and Discard: the screen the user came from. */
  cancelTo: string;
  /** Save: the origin again, showing the new pin when it came from a plan or the 3D view; otherwise the new task itself. */
  saveTo(taskId: string): string;
}

/** `back=/linkview/...`: the Link view opened the form, so Cancel and Save return to it (only that in-app path is accepted). */
export function linkviewBack(search: URLSearchParams | string): string | null {
  const q = typeof search === "string" ? new URLSearchParams(search) : search;
  const b = q.get("back");
  return b && /^\/linkview\/[A-Za-z0-9_%-]+(\?[A-Za-z0-9_.,=&%+-]*)?$/.test(b) ? b : null;
}

export function newTaskExit(search: URLSearchParams | string): NewTaskExit {
  const params = parseNewTaskParams(search);
  const a = params.draftId ? null : params.anchor;
  const back = params.draftId ? null : linkviewBack(search);
  if (back && a?.kind === "pdf") return { origin: "plan", cancelTo: back, saveTo: () => back };
  if (a?.kind === "pdf") {
    const to = `/plans/${encodeURIComponent(a.pdfFileId)}`;
    return { origin: "plan", cancelTo: to, saveTo: () => to };
  }
  if (a?.kind === "bim") {
    const base = params.buildingId ? `/model/${encodeURIComponent(params.buildingId)}` : "/model";
    return { origin: "model", cancelTo: base, saveTo: (id) => `${base}?task=${encodeURIComponent(id)}` };
  }
  return { origin: "tasks", cancelTo: "/tasks", saveTo: (id) => `/tasks/${id}` };
}
