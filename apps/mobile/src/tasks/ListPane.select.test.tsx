// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { TaskView } from "@ff/tasks";

vi.mock("@ff/auth", () => ({ useAuth: () => ({ user: { uid: "u1" } }), useProjectId: () => "p1" }));
vi.mock("../platform/network", () => ({ useNetworkStatus: () => ({ online: true }) }));
vi.mock("@ff/tasks-react", async (orig) => ({ ...(await orig<typeof import("@ff/tasks-react")>()), useTaskEngine: () => null }));
// the bar and the export dialog have their own tests; here only the list's selection behaviour
vi.mock("./bulk/BulkBar", () => ({
  BulkBar: ({ rows }: { rows: unknown[] }) => <div data-testid="bulk-bar" data-count={rows.length} />,
  BulkResult: () => null,
}));
vi.mock("./export/ExportSheet", () => ({ ConnectedExportSheet: () => <div data-testid="export-sheet" /> }));

import { EMPTY_TASK_BUILDING_INDEX, selectTaskList } from "@ff/tasks-react";
import { ListPane } from "./ListPane";
import { useSelection } from "./bulk/selection";

const listOf = (t: TaskView[]) =>
  selectTaskList(t, { chip: "all", search: "", sort: "updated", view: null, scope: "all", buildingId: null, quick: {}, columnFilters: {}, uid: "u1", now: Date.now(), buildingIndex: EMPTY_TASK_BUILDING_INDEX, buildingNames: new Map() });

const make = (n: number): TaskView[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `c${i}`, num: i + 1, title: `Task ${i}`, status: 20, updatedAt: 1e12 - i, createdAt: 1e12 - i, assigneeName: null, assigneeUid: null, deadline: null, buildingId: null, description: "",
    type: null, createdBy: "x", priority: null, location: null, lastAction: "create", entryCount: 1, photos: [],
  })) as unknown as TaskView[];

function setup(n = 5) {
  const t = make(n);
  return render(
    <MemoryRouter initialEntries={["/tasks"]}>
      <Routes>
        <Route path="/tasks" element={<ListPane tasks={t} loaded hasMore={false} onLoadMore={() => undefined} drafts={[]} list={listOf(t)} />} />
        <Route path="/tasks/:id" element={<div data-testid="opened" />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  act(() => useSelection.getState().exit());
});

describe("ListPane select mode", () => {
  it("Select shows checkboxes; tapping a row toggles it instead of opening it; the bar appears with the count", () => {
    const r = setup();
    expect(r.queryAllByTestId("row-check")).toHaveLength(0);
    fireEvent.click(r.getByTestId("select-mode"));
    expect(r.getAllByTestId("row-check")).toHaveLength(5);
    expect(r.queryByTestId("bulk-bar")).toBeNull();
    const rows = r.getAllByTestId("task-row");
    fireEvent.click(rows[1]!);
    fireEvent.click(rows[3]!);
    expect(r.queryByTestId("opened")).toBeNull();
    expect(r.getByTestId("bulk-bar").getAttribute("data-count")).toBe("2");
    expect(rows[1]!.getAttribute("data-checked")).toBe("1");
    fireEvent.click(rows[1]!);
    expect(r.getByTestId("bulk-bar").getAttribute("data-count")).toBe("1");
  });

  it("Select all visible, Clear and Done", () => {
    const r = setup(7);
    fireEvent.click(r.getByTestId("select-mode"));
    expect(r.getByTestId("select-all").textContent).toContain("Select all visible (7)");
    fireEvent.click(r.getByTestId("select-all"));
    expect(r.getByTestId("bulk-bar").getAttribute("data-count")).toBe("7");
    expect(r.getByTestId("select-all").textContent).toContain("Deselect all");
    fireEvent.click(r.getByTestId("select-clear"));
    expect(r.queryByTestId("bulk-bar")).toBeNull();
    fireEvent.click(r.getByTestId("select-all"));
    fireEvent.click(r.getByTestId("select-done"));
    expect(r.queryByTestId("select-toolbar")).toBeNull();
    expect(r.queryAllByTestId("row-check")).toHaveLength(0);
    expect(useSelection.getState().ids.size).toBe(0); // Done leaves select mode and drops the selection
  });

  it("a long press on a row enters select mode with that row selected and does not open the task", () => {
    vi.useFakeTimers();
    try {
      const r = setup();
      const row = r.getAllByTestId("task-row")[2]!;
      fireEvent.pointerDown(row, { clientX: 10, clientY: 10, button: 0 });
      act(() => void vi.advanceTimersByTime(600));
      fireEvent.pointerUp(row);
      fireEvent.click(row); // the click that follows the press
      expect(r.queryByTestId("opened")).toBeNull();
      expect(r.getByTestId("select-toolbar")).toBeTruthy();
      expect(r.getByTestId("bulk-bar").getAttribute("data-count")).toBe("1");
      expect(r.getAllByTestId("task-row")[2]!.getAttribute("data-checked")).toBe("1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a plain tap still opens the task", () => {
    const r = setup();
    fireEvent.click(r.getAllByTestId("task-row")[0]!);
    expect(r.getByTestId("opened")).toBeTruthy();
  });
});
