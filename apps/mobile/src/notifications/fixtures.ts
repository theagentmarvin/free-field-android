import type { Task, TaskEntry } from "@ff/firestore";

export const ME = { uid: "me", name: "Alex Rivera" };

export function task(over: Partial<Task> = {}): Task {
  return {
    id: "t1",
    num: 12,
    title: "Cracked slab",
    description: "",
    type: "task",
    status: 10,
    createdBy: "Ana Silva",
    createdByUid: "ana",
    createdAt: 1000,
    updatedBy: "Ana Silva",
    updatedAt: 1000,
    assigneeUid: null,
    assigneeName: null,
    deadline: null,
    buildingId: null,
    location: null,
    photos: [],
    lastAction: "create",
    entryCount: 1,
    ...over,
  };
}

export function entry(id: string, over: Partial<TaskEntry> = {}): TaskEntry {
  return { id, clientGuid: id, action: "comment", text: "", by: "Ana Silva", byUid: "ana", at: 2000, statusFrom: null, statusTo: null, photos: [], ...over };
}
