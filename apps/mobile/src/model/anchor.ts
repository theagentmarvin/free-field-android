import { extractPins, type LocatableTask, type PanelTask, type TaskPin } from "@ff/tasks-react";
import { buildNewTaskPath, formatAnchor, parseAnchor, type TaskAnchor } from "../tasks/anchor";
import type { CameraPose, Vec3 } from "./viewMath";

/**
 * Model-tab helpers around the shared `bim:` anchor grammar (docs/ROUTES.md). `expressId` carries the
 * fragments `localId` of the element; its IFC GUID is shown in the properties sheet and is not stored
 * (the task schema keeps the id pair only).
 */
export type BimAnchor = Extract<TaskAnchor, { kind: "bim" }>;

export interface BimPinInput {
  modelId: string;
  localId: number | null;
  point: Vec3 | null;
  pose?: CameraPose | null;
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

export function buildBimAnchor(i: BimPinInput): BimAnchor | null {
  const elements = i.localId !== null && Number.isInteger(i.localId) && i.localId >= 0 ? [{ modelId: i.modelId, expressId: i.localId }] : [];
  const worldPoint = i.point ? ([r3(i.point[0]), r3(i.point[1]), r3(i.point[2])] as Vec3) : null;
  if (elements.length === 0 && !worldPoint) return null;
  const cameraPose = i.pose
    ? { pos: i.pose.pos.map(r3) as Vec3, target: i.pose.target.map(r3) as Vec3, fov: r3(i.pose.fov), isOrtho: false }
    : null;
  const a: BimAnchor = { kind: "bim", elements, worldPoint, cameraPose };
  // ids must satisfy the grammar; reject here rather than produce an unparseable link
  return parseAnchor(formatAnchor(a)) ? a : null;
}

/** `/tasks/new?anchor=bim:...&building=...[&storey=...]` */
export function newTaskPathForModel(i: BimPinInput, buildingId: string, storey?: string | null): string | null {
  const anchor = buildBimAnchor(i);
  return anchor ? buildNewTaskPath({ anchor, buildingId, storey: storey ?? null }) : null;
}

export interface ModelPin extends TaskPin {
  pending: boolean;
}

/**
 * Pins to draw for one building. A task that names a building must match it; one that does not (legacy)
 * is shown when it points at one of this building's models, or at a bare world point.
 */
export function pinsForBuilding(tasks: readonly PanelTask[], buildingId: string, modelIds: ReadonlySet<string>): ModelPin[] {
  const pending = new Set(tasks.filter((t) => t.pending).map((t) => t.id));
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return extractPins(tasks as unknown as LocatableTask[])
    .filter((p) => {
      const t = byId.get(p.taskId);
      if (t?.buildingId) return t.buildingId === buildingId;
      return p.elements.length === 0 || p.elements.some((e) => modelIds.has(e.modelId));
    })
    .map((p) => ({ ...p, pending: pending.has(p.taskId) }));
}
