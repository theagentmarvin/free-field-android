// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { OutboxRecord } from "@ff/types";

const setCurrentProject = vi.fn();
let memberships: Array<{ id: string; role: string; name?: string }> | undefined = [];
let online = true;
let rows: OutboxRecord[] = [];
const engine = { retryNow: vi.fn(async () => undefined), remove: vi.fn(async () => undefined) };

vi.mock("@ff/auth", () => ({
  useProjectSelection: () => ({ memberships, setCurrentProject, currentProjectId: null }),
  useProjectId: () => "p1",
}));
vi.mock("../auth/useSession", () => ({ useSession: () => ({ status: "signed-in", uid: "u1", email: "a@b.co", demo: false }) }));
vi.mock("../platform/network", () => ({ useNetworkStatus: () => ({ online, connectionType: online ? "wifi" : "none" }) }));
vi.mock("@ff/tasks-react", () => ({ useTaskEngine: () => engine }));
vi.mock("../sync/useOutbox", async () => {
  const model = await import("../sync/outboxModel");
  return { useOutboxRows: () => rows, useOutboxCounts: () => model.outboxCounts(rows) };
});

import { ProjectPickerPage } from "./ProjectPickerPage";
import { SyncPage } from "./SyncPage";
import { SyncChip } from "../shell/SyncChip";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.clearAllMocks();
  online = true;
  rows = [];
  memberships = [];
});

function r(over: Partial<OutboxRecord>): OutboxRecord {
  return {
    id: "x",
    kind: "task-action",
    state: "added",
    projectId: "p1",
    payload: { taskId: "t", title: "Fix door", verb: "create" },
    photoRefs: [],
    attempts: 0,
    clientGuid: "x",
    createdAt: 1,
    ...over,
  };
}

describe("ProjectPickerPage", () => {
  it("lists memberships and picks one", () => {
    memberships = [{ id: "p1", role: "admin", name: "Alpha" }];
    render(<ProjectPickerPage />);
    fireEvent.click(screen.getByTestId("project-p1"));
    expect(setCurrentProject).toHaveBeenCalledWith("p1");
  });
  it("offline: a never-opened project is disabled with 'Available when online'", () => {
    online = false;
    window.localStorage.setItem("ffm-opened-projects:u1", JSON.stringify(["p1"]));
    memberships = [
      { id: "p1", role: "admin", name: "Alpha" },
      { id: "p2", role: "member", name: "Beta" },
    ];
    render(<ProjectPickerPage />);
    expect((screen.getByTestId("project-p1") as HTMLButtonElement).disabled).toBe(false);
    const beta = screen.getByTestId("project-p2") as HTMLButtonElement;
    expect(beta.disabled).toBe(true);
    expect(beta.textContent).toContain("Available when online");
  });
  it("shows the empty state", () => {
    render(<ProjectPickerPage />);
    expect(screen.getByText(/not a member of any project/)).toBeTruthy();
  });
});

describe("SyncPage", () => {
  it("shows the empty state", () => {
    render(<SyncPage />);
    expect(screen.getByTestId("outbox-empty")).toBeTruthy();
  });
  it("lists failed rows with error text, retries, and discards only after confirming", () => {
    rows = [r({ id: "f1", state: "failed", lastError: "[permission-denied] Missing permissions", attempts: 1 }), r({ id: "a1", state: "added", createdAt: 2, payload: { taskId: "t", title: "Fix door", verb: "comment" } })];
    render(<SyncPage />);
    expect(screen.getAllByTestId("outbox-group")).toHaveLength(1);
    expect(screen.getByText(/no longer have permission/i)).toBeTruthy(); // the plain sentence for permission-denied, not the raw engine text
    expect(screen.queryByText("Missing permissions")).toBeNull();
    fireEvent.click(screen.getByTestId("outbox-retry"));
    expect(engine.retryNow).toHaveBeenCalledWith("f1");

    fireEvent.click(screen.getAllByTestId("outbox-discard")[0]);
    expect(engine.remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("confirm-cancel"));
    expect(engine.remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByTestId("outbox-discard")[0]);
    fireEvent.click(screen.getByTestId("confirm-ok"));
    expect(engine.remove).toHaveBeenCalledWith("f1");
  });
});

describe("SyncChip", () => {
  it("shows pending count and a failed badge", () => {
    rows = [r({ id: "1", state: "added" }), r({ id: "2", state: "sending" }), r({ id: "3", state: "failed" })];
    render(<SyncChip />);
    expect(screen.getByTestId("chip-pending").textContent).toBe("2");
    expect(screen.getByTestId("chip-failed").textContent).toContain("1");
    expect(screen.getByTestId("sync-chip").getAttribute("data-state")).toBe("online");
  });
  it("shows offline and no badges when the outbox is empty", () => {
    online = false;
    render(<SyncChip />);
    expect(screen.getByTestId("sync-chip").getAttribute("data-state")).toBe("offline");
    expect(screen.queryByTestId("chip-pending")).toBeNull();
    expect(screen.queryByTestId("chip-failed")).toBeNull();
  });
});
