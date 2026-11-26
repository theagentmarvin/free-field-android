import { Link } from "react-router-dom";
import { useProjectId } from "@ff/auth";
import type { PlanListItem } from "../plans/planModel";
import { usePlanGroups } from "../plans/usePlans";
import { revisionsBadge } from "../plans/revisions";
import { getTileService, useTileState, type TileState } from "../plans/tileService";

/** Plans tab: building -> folder/storey -> plan, each with an offline (tiles) badge. */
export function PlansPage() {
  const projectId = useProjectId() ?? "";
  const data = usePlanGroups(projectId);

  return (
    <section className="pad" data-testid="plans-page">
      <h2>Plans</h2>
      {data === undefined ? (
        <p className="muted">Loading…</p>
      ) : data.length === 0 ? (
        <p className="muted">No plans yet. Make a building available offline from More &gt; Offline.</p>
      ) : (
        data.map((b) => (
          <div key={b.buildingId} data-testid="plan-building">
            <h3>{b.buildingName}</h3>
            {b.groups.map((g) => (
              <div key={g.name} data-testid="plan-group">
                <p className="plan-group-name">{g.name}</p>
                <ul className="list">
                  {g.plans.map((p) => (
                    <PlanRow key={p.pdfFileId} plan={p} />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        ))
      )}
    </section>
  );
}

export function tileBadge(s: TileState): { label: string; cls: string } {
  switch (s.state) {
    case "ready":
      return { label: "Tiles ready", cls: "ok" };
    case "partial":
      return { label: "Partly rendered", cls: "warn" };
    case "rendering": {
      const pct = s.progress.total ? Math.round((100 * s.progress.done) / s.progress.total) : 0;
      return { label: `Rendering ${pct}%`, cls: "warn" };
    }
    case "error":
      return { label: "Render failed", cls: "bad" };
    case "none":
      return { label: "Not rendered", cls: "" };
    default:
      return { label: "…", cls: "" };
  }
}

/** "2 revisions" when the plan has a history to browse; nothing for a single version. */
function RevisionsBadge({ count }: { count: number }) {
  const label = revisionsBadge(count);
  return label ? (
    <span className="tile-badge rev-badge" data-testid="plan-revisions-badge">
      {label}
    </span>
  ) : null;
}

function PlanRow({ plan }: { plan: PlanListItem }) {
  const state = useTileState(plan.offline ? plan.version.id : undefined);
  if (!plan.offline) {
    // Listed (metadata synced) but the PDF is not on the device: greyed out, points at the offline screen.
    return (
      <li className="plan-row is-unavailable" data-testid="plan-row" data-version-id={plan.version.id} data-tile-state="not-offline">
        <Link to="/offline" className="row plan-link" data-testid="plan-get-offline">
          <strong className="grow muted">{plan.name}</strong>
          <RevisionsBadge count={plan.revisionCount} />
          <span className="tile-badge" data-testid="plan-badge">Not offline</span>
        </Link>
      </li>
    );
  }
  const badge = tileBadge(state);
  const canPrepare = state.state === "none" || state.state === "partial" || state.state === "error";
  return (
    <li className="plan-row" data-testid="plan-row" data-version-id={plan.version.id} data-tile-state={state.state}>
      <Link to={`/plans/${plan.pdfFileId}`} className="row plan-link" data-testid="plan-open">
        <strong className="grow">{plan.name}</strong>
        <RevisionsBadge count={plan.revisionCount} />
        <span className={`tile-badge ${badge.cls}`} data-testid="plan-badge" title={state.state === "error" ? state.message : undefined}>
          {badge.label}
        </span>
      </Link>
      {canPrepare && (
        <button
          type="button"
          className="btn"
          data-testid="plan-prepare"
          onClick={() => void getTileService().ensureTiles(plan.ref).catch(() => undefined)}
        >
          {state.state === "none" ? "Render" : "Retry"}
        </button>
      )}
    </li>
  );
}
