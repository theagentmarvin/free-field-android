import { useEffect, useSyncExternalStore } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { getNotice, recordRoute, setNotice, subscribeNotice } from "../recovery/recovery";
import { useIsTablet } from "../platform/useBreakpoint";
import { SyncChip } from "./SyncChip";
import { useProjectSelection } from "@ff/auth";

const TABS = [
  { to: "/plans", label: "Plans" },
  { to: "/model", label: "Model" },
  { to: "/tasks", label: "Tasks" },
  { to: "/sync", label: "Sync" },
  { to: "/more", label: "More" },
] as const;

/** Routes that take the whole screen (no header, no tabs). */
export const isFocusedRoute = (pathname: string): boolean => {
  const p = pathname.replace(/\/+$/, "");
  return p === "/tasks/new" || /^\/tasks\/[^/]+\/markup$/.test(p);
};

export function AppShell({ seedReady }: { seedReady: boolean }) {
  const tablet = useIsTablet();
  const { memberships, currentProjectId } = useProjectSelection();
  const project = memberships?.find((m) => m.id === currentProjectId);
  const loc = useLocation();
  useEffect(() => recordRoute(loc.pathname + loc.search), [loc.pathname, loc.search]);
  const notice = useSyncExternalStore(subscribeNotice, getNotice);

  const nav = (
    <nav className={tablet ? "rail" : "tabbar"} aria-label="Primary" data-testid="tabs">
      {TABS.map((t) => (
        <NavLink key={t.to} to={t.to} className={({ isActive }) => `tab${isActive ? " is-active" : ""}`}>
          {t.label}
        </NavLink>
      ))}
    </nav>
  );

  // The New task screen and the markup editor are focused pages: no header, no navigation, no list beside it.
  const focused = isFocusedRoute(loc.pathname);
  return (
    <div className={`shell ${tablet ? "is-tablet" : "is-phone"}${focused ? " is-focused" : ""}`} data-layout={tablet ? "tablet" : "phone"} data-focused={focused ? "1" : "0"}>
      {!focused && (
        <header className="header">
          <h1>{project?.name ?? "FreeField Field"}</h1>
          <SyncChip />
        </header>
      )}
      {tablet && !focused && nav}
      {notice && (
        <div className="notice" role="status" data-testid="recovery-notice">
          <span>{notice}</span>
          <button type="button" className="btn" onClick={() => setNotice(null)} data-testid="recovery-notice-dismiss">
            OK
          </button>
        </div>
      )}
      <main className="content">
        {seedReady ? <Outlet /> : <p className="muted pad">Preparing data…</p>}
      </main>
      {!tablet && !focused && nav}
    </div>
  );
}
