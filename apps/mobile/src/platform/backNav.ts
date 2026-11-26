/**
 * Hardware Back decision (B57). Capacitor's default handler asks the WebView whether it can go back and finishes the Activity
 * when it cannot. That answer is not reliable for a hash router: entries created without a user gesture are skipped by the
 * WebView, and a freshly launched Activity starts with a single entry, so Back could close the app from the middle of the
 * app. The app decides itself, from its own route and the router's history index.
 *
 *  1. in-app history exists (router index > 0)     -> back one entry
 *  2. a nested screen                              -> its parent screen
 *  3. the root of another tab                      -> the home tab (Tasks)
 *  4. the root of the home tab                     -> leave the app
 */
export const HOME_ROUTE = "/tasks";

export type BackAction = { type: "history" } | { type: "navigate"; to: string } | { type: "exit" };

/** Parent screen of a nested route, or null for a tab root. */
export function parentRoute(path: string): string | null {
  const p = path.replace(/\/+$/, "") || "/";
  if (/^\/tasks\/[^/]+\/(edit|markup)$/.test(p)) return p.replace(/\/(edit|markup)$/, "");
  if (/^\/tasks\/[^/]+$/.test(p)) return "/tasks";
  if (/^\/plans\/[^/]+$/.test(p)) return "/plans";
  if (/^\/model\/[^/]+$/.test(p)) return "/model";
  if (p === "/offline") return "/more";
  return null;
}

/** `historyIndex` is the router's `history.state.idx` (null/undefined when unknown, e.g. after an external hash change). */
export function decideBack(path: string, historyIndex: number | null | undefined): BackAction {
  if (typeof historyIndex === "number" && historyIndex > 0) return { type: "history" };
  const parent = parentRoute(path);
  if (parent) return { type: "navigate", to: parent };
  const p = path.replace(/\/+$/, "") || "/";
  if (p !== HOME_ROUTE) return { type: "navigate", to: HOME_ROUTE };
  return { type: "exit" };
}
