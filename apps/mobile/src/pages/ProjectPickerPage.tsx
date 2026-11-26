import { useProjectSelection } from "@ff/auth";
import { useNetworkStatus } from "../platform/network";
import { useSession } from "../auth/useSession";
import { pickerEntries, readOpenedProjects } from "../projects/openedProjects";

export function ProjectPickerPage() {
  const { memberships, setCurrentProject } = useProjectSelection();
  const { online } = useNetworkStatus();
  const { uid } = useSession();
  const opened = uid ? readOpenedProjects(window.localStorage, uid) : [];
  const entries = pickerEntries(memberships ?? [], opened, online);
  return (
    <div className="center-screen" data-testid="project-picker">
      <h1>Choose a project</h1>
      {memberships === undefined && <p className="muted">Loading projects…</p>}
      {memberships?.length === 0 && <p className="muted">You are not a member of any project yet.</p>}
      <ul className="list wide">
        {entries.map((m) => (
          <li key={m.id}>
            <button
              className="row"
              data-testid={`project-${m.id}`}
              disabled={!m.available}
              onClick={() => setCurrentProject(m.id)}
            >
              <strong>{m.name}</strong>
              <span className="muted">{m.reason ?? m.role}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
