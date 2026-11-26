import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { linkviewPath } from "./route";
import { usePlanLinkability } from "./useLinkPlans";

/**
 * Entry from the plan viewer: "Plan + 3D" opens the Link view on this plan. A plan without a usable calibration (none, or its level
 * is not in the building) does not link: the button says why instead of opening something that cannot work.
 */
export function PlanLinkButton({ projectId, pdfFileId }: { projectId: string; pdfFileId: string }) {
  const link = usePlanLinkability(projectId, pdfFileId);
  const navigate = useNavigate();
  const [why, setWhy] = useState(false);
  if (!link) return null;
  const ok = link.plans.length > 0;
  return (
    <>
      <button
        type="button"
        className={`btn small${ok ? "" : " is-unlinked"}`}
        data-testid="plan-linkview"
        data-linkable={ok ? "1" : "0"}
        onClick={() => (ok ? navigate(linkviewPath(link.buildingId, { plan: pdfFileId, storey: link.plans[0].storeyName })) : setWhy(true))}
      >
        Plan + 3D
      </button>
      {why && (
        <div className="scrim" data-testid="lv-uncalibrated" role="dialog" aria-label="Plan and 3D" onClick={() => setWhy(false)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h2>This plan is not linked to the model</h2>
            <p className="dialog-body">The plan has not been calibrated to a level of the 3D model, so the app cannot tell where a point on the sheet is in the building. Calibrate it to a level in FreeField on the web (two points that exist on both), sync, and Plan + 3D works here, also offline.</p>
            <div className="dialog-actions">
              <button type="button" className="btn primary" data-testid="lv-uncalibrated-close" onClick={() => setWhy(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
