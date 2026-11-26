import { useEffect } from "react";
import { useAuth, useProjectId } from "@ff/auth";
import { getDemoTaskDatabase, getDemoTaskSource } from "@ff/tasks";
import type { Task, TaskEntry } from "@ff/firestore";
import { useRoster } from "../tasks/hooks";
import { dispatchNotificationTap } from "../notifications/platform";
import { addPhoto } from "../tasks/photoStore";
import { buildComposeEnqueues, emptyCompose, useTaskEngine, type ComposeFields } from "@ff/tasks-react";

declare global {
  interface Window {
    __ffmTest?: {
      createTask(title: string, opts?: { location?: ComposeFields["location"]; buildingId?: string | null }): Promise<string>;
      /** Real photo path (process, store, register, enqueue) with `count` noisy JPEGs of roughly `kb` KB each. */
      createTaskWithPhotos(title: string, count: number, kb?: number): Promise<string>;
      /** Simulate another user's change arriving from the server (demo store write + listener poke). */
      simulateRemote(spec: SimulatedRemote): Promise<string>;
      /** Deliver a notification tap as the OS would (path + the project it was raised for). */
      tapNotification(tap: { path: string; projectId: string | null }): void;
    };
  }
}

export interface SimulatedRemote {
  /** existing task id to act on; omitted = a new task is created by the other user */
  taskId?: string;
  action: "create" | "assign" | "comment" | "complete";
  title?: string;
  text?: string;
  /** new tasks: assign to the signed-in user */
  assignToMe?: boolean;
  /** epoch ms; due-today / overdue tests */
  deadline?: number | null;
  by?: { uid: string; name: string };
  /** act as the signed-in user (an own edit) */
  asMe?: boolean;
}

/**
 * e2e seam: lets the Playwright specs create a task through the real outbox path
 * (same payload builder as the web compose sheet) until the mobile compose UI exists.
 */
export function TestHooks() {
  const engine = useTaskEngine();
  const projectId = useProjectId();
  const { user } = useAuth();
  const { actor: me } = useRoster();
  useEffect(() => {
    if (!engine || !projectId || !user) return;
    window.__ffmTest = {
      async createTask(title, opts) {
        const taskId = crypto.randomUUID();
        const payloads = buildComposeEnqueues(
          { ...emptyCompose(), title, ...(opts?.location ? { location: opts.location } : {}), ...(opts?.buildingId !== undefined ? { buildingId: opts.buildingId } : {}) },
          { projectId, taskId, actor: me, at: Date.now() },
        );
        for (const p of payloads) await engine.enqueue(p);
        return taskId;
      },
      async createTaskWithPhotos(title, count, kb = 300) {
        const taskId = crypto.randomUUID();
        const photos = [];
        for (let i = 0; i < count; i++) photos.push(await addPhoto(taskId, await noisyJpeg(kb, i)));
        const payloads = buildComposeEnqueues(
          { ...emptyCompose(), title, photos },
          { projectId, taskId, actor: me, at: Date.now() },
        );
        for (const p of payloads) await engine.enqueue(p);
        return taskId;
      },
      tapNotification: dispatchNotificationTap,
      async simulateRemote(spec) {
        const db = getDemoTaskDatabase();
        const by = spec.asMe ? me : (spec.by ?? { uid: "ana-silva", name: "Ana Silva" });
        const at = Date.now();
        const existing = spec.taskId ? (await db.tasks.get(spec.taskId))?.task : undefined;
        let task: Task;
        let entry: TaskEntry;
        const guid = crypto.randomUUID();
        if (existing) {
          const statusTo = spec.action === "complete" ? 40 : spec.action === "assign" ? 20 : existing.status;
          entry = { id: guid, clientGuid: guid, action: spec.action, text: spec.text ?? "", by: by.name, byUid: by.uid, at, statusFrom: existing.status, statusTo, photos: [] };
          task = {
            ...existing,
            status: statusTo,
            lastAction: spec.action,
            updatedBy: by.name,
            updatedAt: at,
            entryCount: existing.entryCount + 1,
            ...(spec.action === "assign" ? { assigneeUid: user.uid, assigneeName: me.name } : {}),
          };
        } else {
          const taskId = spec.taskId ?? crypto.randomUUID();
          const num = ((await db.tasks.where("projectId").equals(projectId).count()) || 0) + 100;
          const mine = spec.assignToMe === true;
          entry = { id: guid, clientGuid: guid, action: "create", text: "", by: by.name, byUid: by.uid, at, statusFrom: null, statusTo: mine ? 20 : 10, photos: [] };
          task = {
            id: taskId,
            num,
            title: spec.title ?? "Remote task",
            description: "",
            type: "task",
            status: mine ? 20 : 10,
            createdBy: by.name,
            createdByUid: by.uid,
            createdAt: at,
            updatedBy: by.name,
            updatedAt: at,
            assigneeUid: mine ? user.uid : null,
            assigneeName: mine ? me.name : null,
            deadline: spec.deadline ?? null,
            buildingId: null,
            location: null,
            photos: [],
            lastAction: "create",
            entryCount: 1,
          };
        }
        await db.transaction("rw", db.tasks, db.entries, async () => {
          await db.tasks.put({ projectId, taskId: task.id, updatedAt: task.updatedAt, task });
          await db.entries.put({ projectId, taskId: task.id, entryId: entry.id, at: entry.at, entry });
        });
        await getDemoTaskSource().deleteTask(projectId, "__poke__"); // notifies every live listener
        return task.id;
      },
    };
    return () => {
      delete window.__ffmTest;
    };
  }, [engine, projectId, user, me]);
  return null;
}

/** A JPEG of about `kb` KB: random-noise pixels do not compress, so the file size tracks the canvas area. */
async function noisyJpeg(kb: number, seed: number): Promise<Blob> {
  const side = Math.max(64, Math.round(Math.sqrt((kb * 1024) / 1.4)));
  const c = document.createElement("canvas");
  c.width = side;
  c.height = side;
  const g = c.getContext("2d")!;
  const img = g.createImageData(side, side);
  let x = (seed + 1) * 2654435761;
  for (let i = 0; i < img.data.length; i += 4) {
    x = (x * 1664525 + 1013904223) >>> 0;
    img.data[i] = x & 255;
    img.data[i + 1] = (x >>> 8) & 255;
    img.data[i + 2] = (x >>> 16) & 255;
    img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return new Promise((r) => c.toBlob((b) => r(b!), "image/jpeg", 0.8));
}
