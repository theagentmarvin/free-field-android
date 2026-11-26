import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { Link, Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useLiveQuery } from "dexie-react-hooks";
import { useProjectId } from "@ff/auth";
import { db } from "@ff/data/db/database";
import { listBuildings } from "@ff/data/db/tables/buildings";
import { usePanelTasks } from "@ff/tasks-react";
import { ModelView, type TaskCapture } from "../model/ModelView";
import { LinkviewEntry } from "../linkview/LinkviewEntry";
import type { LinkContextHandle, LinkviewBinding } from "../linkview/binding";
import type { TaskPin } from "@ff/tasks-react";
import { viewerRegistry } from "../model/lifecycle";
import { pinsForBuilding } from "../model/anchor";
import { useModelSource } from "../model/useModelSource";
import "../model/model.css";

const LAST_KEY = "ffm.model.lastBuilding";
const readLast = (): string | null => {
  try {
    return window.localStorage.getItem(LAST_KEY);
  } catch {
    return null;
  }
};

/** Model tab: building picker + the 3D view of the chosen building's downloaded `.frag` (never IFC). */
export function ModelPage() {
  const projectId = useProjectId() ?? "";
  const { buildingId: param } = useParams();
  const [search] = useSearchParams();
  const taskId = search.get("task");
  const navigate = useNavigate();
  const buildings = useLiveQuery(() => listBuildings(projectId), [projectId]);
  const tasks = usePanelTasks();
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const linkContext = useRef<LinkContextHandle | null>(null);

  const chosen = useMemo(() => {
    if (!buildings || buildings.length === 0) return null;
    const has = (id: string | null | undefined): id is string => !!id && buildings.some((b) => b.id === id);
    if (has(param)) return param;
    const tb = taskId ? tasks.find((t) => t.id === taskId)?.buildingId : null;
    if (has(tb)) return tb;
    const last = readLast();
    return has(last) ? last : buildings[0].id;
  }, [buildings, param, taskId, tasks]);

  useEffect(() => {
    if (chosen) {
      try {
        window.localStorage.setItem(LAST_KEY, chosen);
      } catch {
        /* storage blocked */
      }
    }
  }, [chosen]);

  if (buildings === undefined) return <p className="muted pad">Loading…</p>;
  if (!chosen) return <p className="muted pad" data-testid="model-no-building">No building available yet. Sync a project first.</p>;
  if (param !== chosen) return <Navigate replace to={`/model/${encodeURIComponent(chosen)}${search.toString() ? `?${search.toString()}` : ""}`} />;

  return (
    <div className="model-page" data-testid="model-route" data-building={chosen}>
      <div className="model-bar">
        <label className="muted" htmlFor="model-building">
          Building
        </label>
        <select
          id="model-building"
          className="field"
          data-testid="model-building-picker"
          value={chosen}
          onChange={(e) => navigate(`/model/${encodeURIComponent(e.target.value)}`, { replace: true })}
        >
          {buildings.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
        <span className="model-bar-slot" ref={setSlot} data-testid="model-bar-slot" />
        <LinkviewEntry buildingId={chosen} projectId={projectId} context={linkContext} />
      </div>
      <BuildingModel key={chosen} projectId={projectId} buildingId={chosen} taskId={taskId} tasks={tasks} toolbarSlot={slot} linkContext={linkContext} />
    </div>
  );
}

export function BuildingModel({ projectId, buildingId, taskId, tasks, toolbarSlot, linkview, linkContext, extraPins, capture }: { projectId: string; buildingId: string; taskId: string | null; tasks: ReturnType<typeof usePanelTasks>; toolbarSlot: HTMLElement | null; linkview?: LinkviewBinding; linkContext?: MutableRefObject<LinkContextHandle | null>; extraPins?: readonly TaskPin[]; capture?: TaskCapture }) {
  const source = useModelSource(buildingId);
  const storeys = useLiveQuery(() => db.storeys.where("buildingId").equals(buildingId).toArray(), [buildingId]);
  // One model at a time: wait until the previous building's viewer is fully disposed before creating this one.
  const [clear, setClear] = useState(false);
  useEffect(() => {
    let live = true;
    void viewerRegistry.whenIdle().then(() => live && setClear(true));
    return () => {
      live = false;
    };
  }, []);

  const modelIds = source.status === "ready" ? source.modelIds : null;
  const pins = useMemo(() => {
    const own = modelIds ? pinsForBuilding(tasks, buildingId, modelIds) : [];
    if (!extraPins || extraPins.length === 0) return own;
    const have = new Set(own.map((p) => p.taskId));
    return [...own, ...extraPins.filter((p) => !have.has(p.taskId)).map((p) => ({ ...p, pending: p.pending }))];
  }, [tasks, buildingId, modelIds, extraPins]);

  if (source.status === "loading" || !clear) return <p className="muted pad">Preparing model…</p>;
  if (source.status === "error") return <p className="error pad">Could not prepare the model: {source.error}</p>;
  if (source.status === "none") {
    return (
      <div className="center-screen" data-testid="model-not-downloaded">
        <p>This building's 3D model is not on the device yet.</p>
        <Link to="/offline" className="btn primary" data-testid="model-go-offline">
          Make available offline
        </Link>
      </div>
    );
  }
  return <ModelView projectId={projectId} buildingId={buildingId} source={source} storeys={storeys ?? []} pins={pins} focusTaskId={taskId} toolbarSlot={toolbarSlot} linkview={linkview} linkContext={linkContext} capture={capture} />;
}
