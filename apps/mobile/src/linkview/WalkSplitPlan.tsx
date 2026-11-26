import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useNavigate } from "react-router-dom";
import { usePanelTasks } from "@ff/tasks-react";
import { testHooksEnabled } from "../dev/flag";
import { PlanPane } from "./PlanPane";
import "./linkview.css";
import { newTaskUrl } from "../plans/anchor";
import { pinsForPlan } from "../plans/pins";
import { usePlanRecord } from "../plans/usePlans";
import type { PlanManifest } from "../plans/manifest";
import type { WalkerStore } from "../model/walkSplit";
import type { CalibratedPlan } from "./plans";
import type { LinkWalker } from "./binding";
import { clampToPage, markerFromWalker, pageHeadingFromYaw, walkerFromPage, yawFromPageHeading, type PagePt } from "./sync";

interface Props {
  plan: CalibratedPlan;
  store: WalkerStore;
  /** where to come back to from "New task" on the plan */
  backPath: string;
  /** the plan was tapped (or the marker dragged): move the walker there */
  onMove: (w: LinkWalker) => void;
  /** the marker's heading handle was turned */
  onTurn: (yaw: number) => void;
}

declare global {
  interface Window {
    __ffmWalkSplit?: { state(): Record<string, unknown> };
  }
}

/** The plan side of walk mode: the Link view's plan pane (same tile viewer and render cache) with the walker's marker. Mount one at a time. */
export function WalkSplitPlan({ plan, store, backPath, onMove, onTurn }: Props) {
  const navigate = useNavigate();
  const tasks = usePanelTasks();
  const walker = useSyncExternalStore(store.subscribe, store.get);
  const rec = usePlanRecord(plan.pdfFileId);
  const [manifest, setManifest] = useState<PlanManifest | null>(null);
  const page = useMemo(() => (manifest && rec?.version?.id === manifest.planVersionId ? { width: manifest.pageWidth, height: manifest.pageHeight } : null), [manifest, rec?.version?.id]);
  const params = plan.calibration.transformParams;
  const raw = walker ? markerFromWalker(params, walker) : null;
  const marker = raw && page ? { ...raw, page: clampToPage(raw.page, page) } : raw;
  const pins = useMemo(() => (rec?.version ? pinsForPlan(tasks, plan.pdfFileId, rec.version.id, 1, rec.versions) : []), [tasks, rec, plan.pdfFileId]);

  useEffect(() => {
    if (!testHooksEnabled()) return;
    window.__ffmWalkSplit = { state: () => ({ plan: plan.pdfFileId, storey: plan.storeyName, params, page, walker: store.get() }) };
    return () => {
      delete window.__ffmWalkSplit;
    };
  });

  const place = useCallback(
    (pt: PagePt) => {
      const cur = store.get();
      if (!cur) return;
      onMove(walkerFromPage(params, cur.floorY, page ? clampToPage(pt, page) : pt, pageHeadingFromYaw(params, cur.yaw)));
    },
    [store, params, page, onMove],
  );
  const turn = useCallback((heading: number) => onTurn(yawFromPageHeading(params, heading)), [params, onTurn]);

  return (
    <PlanPane
      rec={rec}
      pins={pins}
      marker={marker}
      onPlace={place}
      onTurn={turn}
      onPinTap={(id) => navigate(`/tasks/${id}`)}
      onNewTask={(versionId, uv) => navigate(`${newTaskUrl({ pdfFileId: plan.pdfFileId, planVersionId: versionId, page: 1, uv })}&back=${encodeURIComponent(backPath)}`)}
      onManifest={setManifest}
    />
  );
}
