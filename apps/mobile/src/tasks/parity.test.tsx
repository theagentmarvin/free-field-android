// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, renderHook, screen, fireEvent } from "@testing-library/react";
import type { TaskView } from "@ff/tasks";
import {
  EMPTY_TASK_BUILDING_INDEX,
  SAVED_VIEWS,
  applyColumnFilters,
  applyQuickFilters,
  chipCounts,
  distinctOptions,
  matchesChip,
  scopeRowsToBuilding,
  visibleTasks,
  type ActiveFilters,
  type Chip,
  type SortKey,
  type TaskTableRow,
} from "@ff/tasks-react";

vi.mock("@ff/tasks-react", async (orig) => ({
  ...(await orig<typeof import("@ff/tasks-react")>()),
  useTaskBuildingIndex: () => EMPTY_TASK_BUILDING_INDEX,
}));

import { useListStore } from "./listStore";
import { useTaskListQuery } from "./useTaskListQuery";
import { FilterSheet, ActiveFilterChips } from "./filters";

/**
 * Parity: the tablet list must equal the web's for the same rows and filters. The reference below composes the web's PUBLIC
 * pure functions exactly as the Tasks module does (merged rows -> saved-view predicates + search + sort -> building scope -> quick
 * filters -> status chip -> column filters); the tablet side goes through its store and `useTaskListQuery`.
 */
const NOW = new Date(2026, 10, 18, 12, 0, 0).getTime();
const DAY = 86_400_000;
const mk = (o: Partial<TaskView> & { id: string; status: number }): TaskView =>
  ({ num: 1, title: "t", updatedAt: 1, createdAt: 1, assigneeName: null, lastAction: "create", entryCount: 1, ...o }) as TaskView;

const FIX: TaskView[] = [
  mk({ id: "a", num: 1, status: 10, title: "Cracked wall", updatedAt: 50, createdAt: NOW - 2 * DAY, assigneeUid: "me", assigneeName: "Me", buildingId: "b1", deadline: NOW - DAY }),
  mk({ id: "b", num: 2, status: 20, title: "Leaking pipe", updatedAt: 90, createdAt: NOW - 30 * DAY, assigneeUid: "bob", assigneeName: "Bob", buildingId: "b2", deadline: NOW + DAY, priority: "high" as never }),
  mk({ id: "c", num: 3, status: 40, title: "Door RFI", updatedAt: 70, createdAt: NOW - 1000, assigneeUid: "me", assigneeName: "Me", buildingId: "b1", deadline: NOW + 20 * DAY, type: "rfi" }),
  mk({ id: "d", num: 4, status: 65, title: "Done thing", updatedAt: 30, createdAt: NOW - 9 * DAY, assigneeUid: "me", assigneeName: "Me", buildingId: null, deadline: NOW - 5 * DAY }),
  mk({ id: "e", num: 5, status: 80, title: "Dropped", updatedAt: 10, createdAt: NOW - 40 * DAY, buildingId: "b2" }),
  mk({ id: "f", num: 6, status: 60, title: "Follow up", updatedAt: 20, createdAt: NOW - 3 * DAY, assigneeUid: "bob", assigneeName: "Bob", buildingId: "b1", location: { storeyName: "L2" } as never }),
  mk({ id: "g", num: 7, status: 20, title: "Cable tray", updatedAt: 80, createdAt: NOW - 3600_000, assigneeUid: "me", assigneeName: "Me", buildingId: "b1", deadline: NOW + 2 * DAY }),
];
const NAMES = new Map([["b1", "North"], ["b2", "South"]]);

interface Scenario {
  chip?: Chip;
  search?: string;
  sort?: SortKey;
  viewId?: string | null;
  scopeBuildingId?: string | null;
  quick?: { mine?: boolean; overdue?: boolean };
  columnFilters?: ActiveFilters;
}

// choosing a saved view applies its chip/sort/scope (web `applyView`); an explicit chip or sort chosen afterwards wins
function chipOf(s: Scenario): Chip {
  return s.chip ?? SAVED_VIEWS.find((v) => v.id === s.viewId)?.apply.chip ?? "all";
}
function sortOf(s: Scenario): SortKey {
  return s.sort ?? SAVED_VIEWS.find((v) => v.id === s.viewId)?.apply.sort ?? "updated";
}

function webIds(s: Scenario): string[] {
  const view = SAVED_VIEWS.find((v) => v.id === s.viewId) ?? null;
  const scope = view?.apply.scope ?? "all";
  const merged = visibleTasks(FIX, [], {
    chip: "all", search: s.search ?? "", sort: sortOf(s), limit: Number.POSITIVE_INFINITY,
    assigneeUid: view?.apply.myTasks ? "me" : undefined, overdueOnly: view?.apply.overdueOnly, overdueNow: NOW,
  });
  const pre = scopeRowsToBuilding(merged, s.scopeBuildingId ?? "b1", scope);
  const quick = applyQuickFilters(pre, s.quick ?? {}, "me", NOW);
  const chip = quick.filter((t) => matchesChip(t.status, chipOf(s)));
  const rows = chip.map((t) => ({ ...t, buildingName: t.buildingId ? (NAMES.get(t.buildingId) ?? null) : null, storeyName: null })) as TaskTableRow[];
  return applyColumnFilters(rows, s.columnFilters ?? {}, NOW).map((r) => r.id);
}
function webCounts(s: Scenario) {
  const view = SAVED_VIEWS.find((v) => v.id === s.viewId) ?? null;
  const merged = visibleTasks(FIX, [], {
    chip: "all", search: s.search ?? "", sort: sortOf(s), limit: Number.POSITIVE_INFINITY,
    assigneeUid: view?.apply.myTasks ? "me" : undefined, overdueOnly: view?.apply.overdueOnly, overdueNow: NOW,
  });
  return chipCounts(applyQuickFilters(scopeRowsToBuilding(merged, s.scopeBuildingId ?? "b1", view?.apply.scope ?? "all"), s.quick ?? {}, "me", NOW));
}

function tablet(s: Scenario) {
  act(() => {
    const st = useListStore.getState();
    st.reset();
    if (s.viewId) st.applyView(s.viewId);
    // explicit chip/sort override the view preset, as a later tap does
    if (s.chip !== undefined) st.setChip(s.chip);
    if (s.sort !== undefined) st.setSort(s.sort);
    if (s.search) st.setSearch(s.search);
    if (s.scopeBuildingId) st.setScopeBuilding(s.scopeBuildingId);
    if (s.quick) st.setQuick(s.quick);
    for (const [col, f] of Object.entries(s.columnFilters ?? {})) st.setColumnFilter(col as never, f);
  });
  return renderHook(() => useTaskListQuery(FIX, "me", NAMES, "b1")).result.current;
}

const SCENARIOS: Array<[string, Scenario]> = [
  ["default (All, updated)", {}],
  ["Open chip", { chip: "open" }],
  ["Awaiting approval chip", { chip: 40 }],
  ["Closed chip", { chip: "closed" }],
  ["search by title", { search: "pipe" }],
  ["search by task number", { search: "t003" }],
  ["search by assignee", { search: "bob" }],
  ["sort deadline", { sort: "deadline" }],
  ["sort created", { sort: "created" }],
  ["saved view My tasks", { viewId: "my" }],
  ["saved view Overdue", { viewId: "overdue" }],
  ["saved view This building (b1)", { viewId: "building" }],
  ["saved view This building (b2)", { viewId: "building", scopeBuildingId: "b2" }],
  ["saved view All", { viewId: "all" }],
  ["quick Mine", { quick: { mine: true } }],
  ["quick Overdue", { quick: { overdue: true } }],
  ["status column filter", { columnFilters: { status: { kind: "distinct", keys: ["Ongoing", "Inbox"] } } }],
  ["assignee column filter", { columnFilters: { assigneeName: { kind: "distinct", keys: ["Bob"] } } }],
  ["building column filter", { columnFilters: { building: { kind: "distinct", keys: ["North"] } } }],
  ["priority column filter", { columnFilters: { priority: { kind: "distinct", keys: ["High"] } } }],
  ["deadline presets", { columnFilters: { deadline: { kind: "deadline", presets: ["overdue", "today", "next7"] } } }],
  ["no deadline preset", { columnFilters: { deadline: { kind: "deadline", presets: ["none"] } } }],
  ["created date preset", { columnFilters: { createdAt: { kind: "date", presets: ["past7"] } } }],
  ["title contains", { columnFilters: { title: { kind: "contains", query: "ea" } } }],
  ["number range", { columnFilters: { num: { kind: "number", min: 2, max: 5 } } }],
  ["combined", { chip: "open", search: "a", viewId: "my", quick: { overdue: true }, columnFilters: { building: { kind: "distinct", keys: ["North"] }, num: { kind: "number", min: 1, max: null } } }],
];

describe("tablet task list = web task list", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    useListStore.getState().reset();
  });

  for (const [name, s] of SCENARIOS) {
    it(name, () => {
      const got = tablet(s);
      expect(got.rows.map((r) => r.id)).toEqual(webIds(s));
      // the chip counts the tablet shows are the web's
      expect(got.counts).toEqual(webCounts(s));
    });
  }

  it("the Title A-Z sort is the web's title column sort", () => {
    const got = tablet({ sort: "title" as never });
    expect(got.rows.map((r) => r.title)).toEqual([...FIX.map((t) => t.title)].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1)));
  });

  it("re-filtering reuses the row objects (no per-keystroke allocation of thousands of rows)", () => {
    const first = tablet({}).rows;
    const second = tablet({ search: "" }).rows;
    expect(first.every((r, i) => r === second[i])).toBe(true);
  });
});

describe("filter sheet", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    useListStore.getState().reset();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  const sheet = () => {
    const rows = tablet({}).rows;
    return render(
      <>
        <FilterSheet tableRows={rows} quickCounts={{ mine: 3, overdue: 2 }} resultCount={rows.length} views={SAVED_VIEWS} buildings={[]} firstBuildingId={null} onClose={() => undefined} />
        <ActiveFilterChips />
      </>,
    );
  };

  it("lists every filterable registry column", () => {
    sheet();
    for (const id of ["num", "title", "type", "status", "priority", "assigneeName", "building", "deadline", "createdBy", "createdAt", "updatedAt", "entryCount", "location"]) {
      expect(screen.getByTestId(`filter-col-${id}`)).toBeTruthy();
    }
    expect(screen.queryByTestId("filter-col-photos")).toBeNull(); // no filterKind, no filter
  });

  it("distinct options carry the counts of distinctOptions, and tapping one filters and shows a removable chip", () => {
    sheet();
    fireEvent.click(screen.getByTestId("filter-head-assigneeName"));
    const expected = distinctOptions(tablet({}).tableRows, "assigneeName");
    for (const o of expected) expect(screen.getByTestId(`fopt-assigneeName-${o.key}`).textContent).toContain(String(o.count));
    fireEvent.click(screen.getByTestId("fopt-assigneeName-Bob"));
    expect(useListStore.getState().columnFilters.assigneeName).toEqual({ kind: "distinct", keys: ["Bob"] });
    expect(screen.getByTestId("active-assigneeName").textContent).toContain("Bob");
    fireEvent.click(screen.getByTestId("active-remove-assigneeName"));
    expect(useListStore.getState().columnFilters.assigneeName).toBeUndefined();
  });

  it("deadline presets, contains and number min/max write the web's filter shapes; clear-all empties them", () => {
    sheet();
    fireEvent.click(screen.getByTestId("filter-head-deadline"));
    fireEvent.click(screen.getByTestId("fopt-deadline-overdue"));
    fireEvent.click(screen.getByTestId("filter-head-title"));
    fireEvent.change(screen.getByTestId("fcontains-title"), { target: { value: "wall" } });
    fireEvent.click(screen.getByTestId("filter-head-num"));
    fireEvent.change(screen.getByTestId("fmin-num"), { target: { value: "2" } });
    fireEvent.change(screen.getByTestId("fmax-num"), { target: { value: "9" } });
    const f = useListStore.getState().columnFilters;
    expect(f.deadline).toEqual({ kind: "deadline", presets: ["overdue"] });
    expect(f.title).toEqual({ kind: "contains", query: "wall" });
    expect(f.num).toEqual({ kind: "number", min: 2, max: 9 });
    fireEvent.click(screen.getByTestId("filters-clear-all"));
    expect(useListStore.getState().columnFilters).toEqual({});
  });
});
