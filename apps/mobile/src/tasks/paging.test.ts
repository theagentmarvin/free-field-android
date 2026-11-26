import { describe, expect, it } from "vitest";
import { hasMoreTasks, nextLimit, TASK_PAGE } from "./paging";

describe("task list paging", () => {
  it("offers more only when the source filled the whole fetch limit", () => {
    expect(hasMoreTasks(TASK_PAGE, TASK_PAGE)).toBe(true);
    expect(hasMoreTasks(TASK_PAGE - 1, TASK_PAGE)).toBe(false);
    expect(hasMoreTasks(0, TASK_PAGE)).toBe(false);
  });
  it("grows the limit one page at a time until everything is loaded", () => {
    let limit = TASK_PAGE;
    const total = 1234;
    let pages = 1;
    while (hasMoreTasks(Math.min(total, limit), limit)) {
      limit = nextLimit(limit);
      pages += 1;
    }
    expect(pages).toBe(7);
    expect(Math.min(total, limit)).toBe(total);
  });
});
