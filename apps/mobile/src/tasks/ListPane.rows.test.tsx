// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { TaskView } from "@ff/tasks";

// PERF-1: draining a queue re-renders the list on every outbox transition and snapshot. With thousands of tasks loaded the rows
// must not be rebuilt unless their own data changed.
const chipRenders = vi.hoisted(() => ({ n: 0 }));

vi.mock("@ff/auth", () => ({ useAuth: () => ({ user: { uid: "u1" } }), useProjectId: () => "p1" }));
vi.mock("../platform/network", () => ({ useNetworkStatus: () => ({ online: true }) }));
vi.mock("@ff/tasks-react", async (orig) => ({
  ...(await orig<typeof import("@ff/tasks-react")>()),
  useTaskEngine: () => null,
}));
vi.mock("./ui", async (orig) => ({
  ...(await orig<typeof import("./ui")>()),
  StatusChip: () => {
    chipRenders.n += 1;
    return null;
  },
}));

import { EMPTY_TASK_BUILDING_INDEX, selectTaskList } from "@ff/tasks-react";
import { ListPane } from "./ListPane";

const listOf = (t: TaskView[]) =>
  selectTaskList(t, {
    chip: "all", search: "", sort: "updated", view: null, scope: "all", buildingId: null, quick: {}, columnFilters: {}, uid: "u1",
    now: Date.now(), buildingIndex: EMPTY_TASK_BUILDING_INDEX, buildingNames: new Map(),
  });

const make = (n: number): TaskView[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `c${i}`, num: i, title: `Task ${i}`, status: 20, updatedAt: 1e12 - i, createdAt: 1e12 - i, assigneeName: null, assigneeUid: null,
    deadline: null, buildingId: null, description: "", type: null, createdBy: "x", priority: null, location: null, lastAction: "create",
    entryCount: 1, photos: [],
  })) as unknown as TaskView[];

describe("ListPane rows", () => {
  it("re-renders only the rows whose data changed", () => {
    const tasks = make(500);
    const base = { loaded: true, hasMore: false, onLoadMore() {}, drafts: [] };
    const ui = (t: TaskView[]) => (
      <MemoryRouter>
        <ListPane {...base} tasks={t} list={listOf(t)} />
      </MemoryRouter>
    );
    const r = render(ui(tasks));
    expect(chipRenders.n).toBe(500);
    chipRenders.n = 0;
    // a new snapshot: every object is new, one task changed
    const next = tasks.map((x) => ({ ...x }));
    next[7] = { ...next[7], title: "Changed", pending: true } as TaskView;
    r.rerender(ui(next));
    expect(chipRenders.n).toBe(1);
    expect(r.getByText("Changed")).toBeTruthy();
  });
});
