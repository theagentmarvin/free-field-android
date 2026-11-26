/** Tasks fetched per page; the list grows by this much each time "Load more" is used. */
export const TASK_PAGE = 200;

/**
 * True while the source may hold more tasks than the current fetch limit returned. A source that returns
 * exactly `limit` rows was cut off by the limit (a smaller answer means everything arrived).
 */
export function hasMoreTasks(fetched: number, limit: number): boolean {
  return limit > 0 && fetched >= limit;
}

export const nextLimit = (limit: number): number => limit + TASK_PAGE;
