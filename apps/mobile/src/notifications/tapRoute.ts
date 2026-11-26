import type { NotificationTap } from "./platform";

export type TapRoute =
  /** same project (or an old notification without one): just open the path */
  | { kind: "open"; path: string }
  /** another project the user belongs to: switch, then open the path */
  | { kind: "switch"; projectId: string; path: string }
  /** the user left that project: show a friendly message */
  | { kind: "not-member" }
  /** memberships have not loaded yet (cold start from a tap): hold the tap */
  | { kind: "wait" };

export function resolveTap(tap: NotificationTap, currentProjectId: string | null | undefined, memberships: ReadonlyArray<{ id: string }> | undefined): TapRoute {
  if (!tap.projectId || tap.projectId === currentProjectId) return { kind: "open", path: tap.path };
  if (!memberships) return { kind: "wait" };
  if (!memberships.some((m) => m.id === tap.projectId)) return { kind: "not-member" };
  return { kind: "switch", projectId: tap.projectId, path: tap.path };
}

export const NOT_MEMBER_MESSAGE = "You no longer have access to the project that notification was about.";
