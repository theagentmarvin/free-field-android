import { useState, type MutableRefObject } from "react";
import { useNavigate } from "react-router-dom";
import { Link } from "react-router-dom";
import type { LinkContextHandle } from "./binding";
import { bearingFromYaw } from "./sync";
import { linkviewPath } from "./route";
import { plansForStorey } from "./plans";
import { useLinkData } from "./useLinkPlans";

interface Props {
  buildingId: string;
  projectId: string;
  /** Reader of the 3D view's level, position and heading (filled by the ModelView). */
  context: MutableRefObject<LinkContextHandle | null>;
}

/**
 * Entry from the 3D view: "Plan + 3D" opens a sheet with the calibrated plans of the building, those of the level you are on
 * first. Choosing one opens the Link view standing where the 3D camera is (when that is on the sheet), else at the plan's anchor.
 */
export function LinkviewEntry({ buildingId, projectId, context }: Props) {
  const data = useLinkData(projectId, buildingId);
  const navigate = useNavigate();
  const [open, setOpen] = useState<{ storey: string | null } | null>(null);
  if (!data) return null;
  const here = open?.storey ?? null;
  const current = here ? plansForStorey(data.plans, here) : [];
  const others = data.plans.filter((p) => !current.includes(p));

  const go = (pdfFileId: string, storeyName: string) => {
    const c = context.current?.read();
    const start = c && c.x !== null && c.z !== null && c.storeyName === storeyName ? { x: c.x, z: c.z, bearingDeg: c.yaw !== null ? (bearingFromYaw(c.yaw) * 180) / Math.PI : undefined } : null;
    navigate(linkviewPath(buildingId, { plan: pdfFileId, storey: storeyName, start }));
  };

  return (
    <>
      <button type="button" className="btn small" data-testid="model-linkview" onClick={() => setOpen({ storey: context.current?.read().storeyName ?? null })}>
        Plan + 3D
      </button>
      {open && (
        <div className="scrim" data-testid="lv-picker" role="dialog" aria-label="Plan and 3D" onClick={() => setOpen(null)}>
          <div className="dialog lv-picker" onClick={(e) => e.stopPropagation()}>
            <h2>Plan + 3D</h2>
            {data.plans.length === 0 ? (
              <>
                <p className="dialog-body" data-testid="lv-picker-none">
                  No plan of this building is calibrated to a level yet. Calibrate a plan to a level in FreeField on the web, sync, and it appears here.
                </p>
                <div className="dialog-actions">
                  <Link to="/plans" className="btn" data-testid="lv-picker-plans">
                    Plans
                  </Link>
                  <button type="button" className="btn primary" onClick={() => setOpen(null)}>
                    Close
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="muted lv-picker-sub">{here ? `You are on ${here}. Pick the plan to walk with:` : "Pick the plan to walk with:"}</p>
                <ul className="list lv-picker-list">
                  {[...current, ...others].map((p) => (
                    <li key={`${p.pdfFileId}:${p.storeyName}`}>
                      <button type="button" className={`row${current.includes(p) ? " is-selected" : ""}`} data-testid="lv-pick-plan" data-pdf={p.pdfFileId} data-storey={p.storeyName} onClick={() => go(p.pdfFileId, p.storeyName)}>
                        <span className="grow">{p.name}</span>
                        <span className="tile-badge">{p.storeyName}</span>
                      </button>
                    </li>
                  ))}
                </ul>
                <div className="dialog-actions">
                  <button type="button" className="btn" data-testid="lv-picker-close" onClick={() => setOpen(null)}>
                    Cancel
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
