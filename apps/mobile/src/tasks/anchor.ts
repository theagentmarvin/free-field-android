import type { TaskLocation } from "@ff/firestore";
import { UNCALIBRATED_CALIB_ID } from "@ff/types";

/**
 * Task anchor: where a new task is pinned. Carried in the single `anchor`
 * query parameter of `/tasks/new` so the plan viewer and the model viewer can
 * deep-link into the create form. Documented in docs/ROUTES.md.
 *
 *   anchor := "pdf:" pdfFileId "/" page "/" u "," v "/" calibId
 *           | "bim:" [elements] ["@" x "," y "," z] ["~" camera]
 *   elements := modelId "." expressId ( "+" modelId "." expressId )*
 *   camera   := px "," py "," pz "," tx "," ty "," tz "," fov "," ortho(0|1)
 *
 * ids are `[A-Za-z0-9_-]+`; numbers are plain decimals. The value must be
 * URL-encoded when placed in a query string (`buildNewTaskPath` does that).
 *
 * The plan viewer's long-press also emits the legacy-compatible form
 *   anchor := "plan~" pdfFileId "~" planVersionId "~" page "~" u "~" v
 * (see plans/anchor.ts); `parseAnchor` accepts it and yields a `pdf` anchor with
 * `planVersionId` set and `calibId` UNCALIBRATED_CALIB_ID until the form resolves the
 * plan's latest calibration from the device database.
 * Companion parameters: `building` (buildingId), `storey` (storey name),
 * `draft` (resume a saved draft; wins over `anchor`).
 */
export type TaskAnchor =
  | {
      kind: "pdf";
      pdfFileId: string;
      page: number;
      uv: [number, number];
      calibId: string;
      /** set only for `plan~` anchors: the calibration still has to be resolved */
      planVersionId?: string;
    }
  | {
      kind: "bim";
      elements: { modelId: string; expressId: number }[];
      worldPoint: [number, number, number] | null;
      cameraPose: {
        pos: [number, number, number];
        target: [number, number, number];
        fov: number;
        isOrtho: boolean;
      } | null;
    };

const ID = /^[A-Za-z0-9_-]+$/;
const NUM = /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i;

function num(s: string): number | null {
  return NUM.test(s) ? Number(s) : null;
}

function nums(s: string, n: number): number[] | null {
  const parts = s.split(",");
  if (parts.length !== n) return null;
  const out = parts.map(num);
  return out.every((x): x is number => x !== null) ? out : null;
}

/** Parse an `anchor` value (already URL-decoded). Returns null when invalid. */
export function parseAnchor(raw: string | null | undefined): TaskAnchor | null {
  if (!raw) return null;
  if (raw.startsWith("plan~")) {
    const [, pdfFileId, planVersionId, pageS, uS, vS] = raw.split("~");
    const page = Number(pageS);
    const u = Number(uS);
    const v = Number(vS);
    if (raw.split("~").length !== 6 || !ID.test(pdfFileId) || !ID.test(planVersionId)) return null;
    if (!Number.isInteger(page) || page < 1 || !Number.isFinite(u) || !Number.isFinite(v)) return null;
    if (u < 0 || u > 1 || v < 0 || v > 1) return null;
    return { kind: "pdf", pdfFileId, page, uv: [u, v], calibId: UNCALIBRATED_CALIB_ID, planVersionId };
  }
  const colon = raw.indexOf(":");
  if (colon < 0) return null;
  const kind = raw.slice(0, colon);
  const body = raw.slice(colon + 1);

  if (kind === "pdf") {
    const parts = body.split("/");
    if (parts.length !== 4) return null;
    const [pdfFileId, pageS, uvS, calibId] = parts;
    const page = Number(pageS);
    const uv = nums(uvS, 2);
    if (!ID.test(pdfFileId) || !ID.test(calibId) || !Number.isInteger(page) || page < 1 || !uv) return null;
    return { kind: "pdf", pdfFileId, page, uv: [uv[0], uv[1]], calibId };
  }

  if (kind === "bim") {
    const [headAndPoint, camS] = body.split("~") as [string, string | undefined];
    const [elsS, pointS] = headAndPoint.split("@") as [string, string | undefined];
    const elements: { modelId: string; expressId: number }[] = [];
    if (elsS) {
      for (const e of elsS.split("+")) {
        const dot = e.lastIndexOf(".");
        if (dot < 1) return null;
        const modelId = e.slice(0, dot);
        const expressId = Number(e.slice(dot + 1));
        if (!ID.test(modelId) || !Number.isInteger(expressId) || expressId < 0) return null;
        elements.push({ modelId, expressId });
      }
    }
    let worldPoint: [number, number, number] | null = null;
    if (pointS !== undefined) {
      const p = nums(pointS, 3);
      if (!p) return null;
      worldPoint = [p[0], p[1], p[2]];
    }
    let cameraPose: Extract<TaskAnchor, { kind: "bim" }>["cameraPose"] = null;
    if (camS !== undefined) {
      const c = nums(camS, 8);
      if (!c || (c[7] !== 0 && c[7] !== 1)) return null;
      cameraPose = {
        pos: [c[0], c[1], c[2]],
        target: [c[3], c[4], c[5]],
        fov: c[6],
        isOrtho: c[7] === 1,
      };
    }
    if (elements.length === 0 && !worldPoint) return null; // an anchor must pin something
    return { kind: "bim", elements, worldPoint, cameraPose };
  }
  return null;
}

/** Inverse of {@link parseAnchor} (not URL-encoded). */
export function formatAnchor(a: TaskAnchor): string {
  if (a.kind === "pdf") return `pdf:${a.pdfFileId}/${a.page}/${a.uv[0]},${a.uv[1]}/${a.calibId}`;
  let s = `bim:${a.elements.map((e) => `${e.modelId}.${e.expressId}`).join("+")}`;
  if (a.worldPoint) s += `@${a.worldPoint.join(",")}`;
  if (a.cameraPose) {
    const c = a.cameraPose;
    s += `~${[...c.pos, ...c.target, c.fov, c.isOrtho ? 1 : 0].join(",")}`;
  }
  return s;
}

export interface NewTaskParams {
  anchor: TaskAnchor | null;
  buildingId: string | null;
  storey: string | null;
  draftId: string | null;
}

export function parseNewTaskParams(search: string | URLSearchParams): NewTaskParams {
  const sp = typeof search === "string" ? new URLSearchParams(search) : search;
  return {
    anchor: parseAnchor(sp.get("anchor")),
    buildingId: sp.get("building") || null,
    storey: sp.get("storey") || null,
    draftId: sp.get("draft") || null,
  };
}

/** `/tasks/new?...` path for linking from the plan and model viewers. */
export function buildNewTaskPath(opts: Partial<NewTaskParams> = {}): string {
  const sp = new URLSearchParams();
  if (opts.anchor) sp.set("anchor", formatAnchor(opts.anchor));
  if (opts.buildingId) sp.set("building", opts.buildingId);
  if (opts.storey) sp.set("storey", opts.storey);
  if (opts.draftId) sp.set("draft", opts.draftId);
  const q = sp.toString();
  return q ? `/tasks/new?${q}` : "/tasks/new";
}

export function anchorToLocation(a: TaskAnchor | null, storeyName: string | null): TaskLocation | null {
  if (!a) return storeyName ? { storeyName, bim: null, pdf: null } : null;
  if (a.kind === "pdf") {
    return {
      storeyName,
      bim: null,
      pdf: {
        pdfFileId: a.pdfFileId,
        page: a.page,
        uv: a.uv,
        calibId: a.calibId,
        // the plan revision the pin was placed on (only anchors from the plan viewer carry it)
        ...(a.planVersionId ? { pdfVersionId: a.planVersionId } : {}),
      },
    };
  }
  return {
    storeyName,
    bim: { elements: a.elements, worldPoint: a.worldPoint, cameraPose: a.cameraPose },
    pdf: null,
  };
}

export function locationToAnchor(loc: TaskLocation | null | undefined): TaskAnchor | null {
  if (!loc) return null;
  if (loc.pdf) {
    return {
      kind: "pdf",
      pdfFileId: loc.pdf.pdfFileId,
      page: loc.pdf.page,
      uv: loc.pdf.uv,
      calibId: loc.pdf.calibId,
      ...(loc.pdf.pdfVersionId ? { planVersionId: loc.pdf.pdfVersionId } : {}),
    };
  }
  if (loc.bim) {
    return {
      kind: "bim",
      elements: loc.bim.elements,
      worldPoint: loc.bim.worldPoint,
      cameraPose: loc.bim.cameraPose,
    };
  }
  return null;
}

// ── deep links out of the Tasks tab ──────────────────────────────────────

/** `/plans/:pdfFileId?task=&page=` (route may not exist yet; links never crash). */
export function planLink(
  loc: { pdf?: { pdfFileId?: string; page?: number } | null } | null | undefined,
  taskId: string,
): string | null {
  const pdf = loc?.pdf;
  if (!pdf?.pdfFileId) return null;
  const sp = new URLSearchParams({ task: taskId });
  if (pdf.page) sp.set("page", String(pdf.page));
  return `/plans/${encodeURIComponent(pdf.pdfFileId)}?${sp.toString()}`;
}

/** `/model/:buildingId?task=` */
export function modelLink(
  loc: { bim?: unknown | null } | null | undefined,
  buildingId: string | null | undefined,
  taskId: string,
): string | null {
  if (!loc?.bim) return null;
  const sp = new URLSearchParams({ task: taskId });
  return buildingId ? `/model/${encodeURIComponent(buildingId)}?${sp.toString()}` : `/model?${sp.toString()}`;
}
