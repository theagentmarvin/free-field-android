// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { TaskView } from "@ff/tasks";
import { buildTaskEdit } from "./edits";
import { ChecklistSection, PriorityRow, SheetsSection, WatchersSection } from "./Extras";

const task = (o: Partial<TaskView> = {}): TaskView =>
  ({ id: "t1", num: 1, title: "T", status: 20, updatedAt: 1, assigneeName: null, lastAction: "create", entryCount: 1, ...o }) as TaskView;
const ctx = { projectId: "p1", actor: { uid: "me", name: "Me" } };

describe("buildTaskEdit with the additive fields", () => {
  it("priority is an edit patch carrying the new value", () => {
    const p = buildTaskEdit(task(), { priority: "high" }, ctx)!;
    expect(p.verb).toBe("edit");
    expect(p.patch).toEqual({ priority: "high" });
    expect(p.text).toContain("priority");
  });
  it("a checklist change carries the FULL next list", () => {
    const items = [{ id: "a", text: "one", done: true }, { id: "b", text: "two", done: false }];
    const p = buildTaskEdit(task({ checklist: [{ id: "a", text: "one", done: false }, { id: "b", text: "two", done: false }] }), { checklist: items }, ctx)!;
    expect(p.patch).toEqual({ checklist: items });
    expect(p.text).toContain("1/2");
  });
  it("watchers and sheet references are patches too; unchanged values enqueue nothing", () => {
    expect(buildTaskEdit(task(), { watchers: ["me"] }, ctx)!.patch).toEqual({ watchers: ["me"] });
    const ref = { pdfFileId: "f1", pdfVersionId: "v1", name: "A-101", versionNumber: 1 };
    expect(buildTaskEdit(task(), { sheetRefs: [ref] }, ctx)!.patch).toEqual({ sheetRefs: [ref] });
    expect(buildTaskEdit(task({ priority: "high" }), { priority: "high" }, ctx)).toBeNull();
  });
  it("a closed task takes no edits", () => {
    expect(buildTaskEdit(task({ status: 65 }), { priority: "low" }, ctx)).toBeNull();
  });
});

describe("detail sections", () => {
  afterEach(cleanup);

  it("checking an item hands the full next list to the editor", () => {
    const onEdit = vi.fn();
    const t = task({ checklist: [{ id: "a", text: "one", done: false }, { id: "b", text: "two", done: true }] });
    render(<ChecklistSection task={t} editable onEdit={onEdit} />);
    expect(screen.getByTestId("detail-checklist").getAttribute("data-done")).toBe("1");
    fireEvent.click(screen.getByTestId("checklist-item-a"));
    expect(onEdit).toHaveBeenCalledWith({ checklist: [{ id: "a", text: "one", done: true }, { id: "b", text: "two", done: true }] });
    fireEvent.click(screen.getByTestId("checklist-item-b"));
    expect(onEdit).toHaveBeenLastCalledWith({ checklist: [{ id: "a", text: "one", done: false }, { id: "b", text: "two", done: false }] });
  });

  it("adds and removes items, and is read-only on a closed task", () => {
    const onEdit = vi.fn();
    const t = task({ checklist: [{ id: "a", text: "one", done: false }] });
    const r = render(<ChecklistSection task={t} editable onEdit={onEdit} />);
    fireEvent.change(screen.getByTestId("checklist-new"), { target: { value: "three" } });
    fireEvent.click(screen.getByTestId("checklist-add"));
    expect(onEdit.mock.calls[0][0].checklist).toHaveLength(2);
    fireEvent.click(screen.getByTestId("checklist-remove-a"));
    expect(onEdit).toHaveBeenLastCalledWith({ checklist: [] });
    r.rerender(<ChecklistSection task={t} editable={false} onEdit={onEdit} />);
    expect((screen.getByTestId("checklist-item-a") as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByTestId("checklist-add")).toBeNull();
  });

  it("priority opens a sheet of four choices", () => {
    const onEdit = vi.fn();
    render(<dl><PriorityRow task={task({ priority: "low" })} editable onEdit={onEdit} /></dl>);
    expect(screen.getByTestId("detail-priority").getAttribute("data-priority")).toBe("low");
    fireEvent.click(screen.getByTestId("priority-button"));
    fireEvent.click(screen.getByTestId("priority-critical"));
    expect(onEdit).toHaveBeenCalledWith({ priority: "critical" });
  });

  it("watchers list names and toggle the signed-in user", () => {
    const onEdit = vi.fn();
    const members = [{ uid: "bob", name: "Bob" }, { uid: "me", name: "Me" }] as never;
    render(<WatchersSection task={task({ watchers: ["bob"] })} members={members} actorUid="me" editable onEdit={onEdit} />);
    expect(screen.getByTestId("watcher").textContent).toBe("Bob");
    fireEvent.click(screen.getByTestId("detail-follow"));
    expect(onEdit).toHaveBeenCalledWith({ watchers: ["bob", "me"] });
  });

  it("attached sheets show their version badge and open on tap", () => {
    const onOpen = vi.fn();
    const catalog = {
      files: new Map([["f1", { id: "f1", buildingId: "b1", name: "A-101" }]]),
      versions: [{ id: "v1", pdfFileId: "f1", versionNumber: 1, isLatest: false }, { id: "v2", pdfFileId: "f1", versionNumber: 2, isLatest: true }],
      folders: [],
      assignments: new Map(),
    };
    const t = task({ sheetRefs: [{ pdfFileId: "f1", pdfVersionId: "v1", versionNumber: 1, name: "A-101" }] });
    render(<SheetsSection task={t} catalog={catalog} editable onEdit={vi.fn()} onOpen={onOpen} />);
    expect(screen.getByTestId("sheet-ref").textContent).toContain("v1 (newer: v2)");
    fireEvent.click(screen.getByTestId("sheet-open-f1"));
    expect(onOpen).toHaveBeenCalled();
  });
});
