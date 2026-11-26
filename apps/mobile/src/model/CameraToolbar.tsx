import { TB_ICONS } from "./toolbarIcons";
import { TOOLBAR_GROUPS, toolbarState, type ToolbarItem, type ToolbarLayout } from "./toolbarLayout";
import { ToolsMenu, type ToolPanel } from "./ToolsMenu";

interface Props {
  layout: ToolbarLayout;
  ready: boolean;
  walking: boolean;
  /** Items to leave out (the Link view is first person only: no Fit, Reset or Walk toggle). */
  hide?: readonly ToolbarItem[];
  measuring: boolean;
  menuOpen: boolean;
  panel: ToolPanel | null;
  toolActive: boolean;
  measureCount: number;
  onFit: () => void;
  onReset: () => void;
  onWalk: () => void;
  onMeasure: () => void;
  onMeasureList: () => void;
  onToggleMenu: () => void;
  onPickTool: (p: Exclude<ToolPanel, "filters">) => void;
}

const LABEL: Record<ToolbarItem, string> = { fit: "Fit", reset: "Reset", walk: "Walk", measure: "Measure", tools: "Tools" };

/**
 * Floating camera toolbar. Grouped: view (Fit, Reset), modes (Walk, Measure: a segmented toggle with a filled active state),
 * Tools. A vertical rail on the right edge in landscape, a bar along the bottom in portrait; every target is 44 px or more and
 * the tools sit on the edges so the model centre stays free.
 */
export function CameraToolbar(p: Props) {
  const st = toolbarState({ ready: p.ready, walking: p.walking, measuring: p.measuring });
  const act: Partial<Record<ToolbarItem, () => void>> = { fit: p.onFit, reset: p.onReset, walk: p.onWalk, measure: p.onMeasure };
  const button = (id: Exclude<ToolbarItem, "tools">) => {
    const s = st[id];
    if (p.hide?.includes(id)) return null;
    const toggle = id === "walk" || id === "measure";
    return (
      <button key={id} type="button" className={`tb-btn${s.on ? " is-on" : ""}`} data-testid={`model-${id}`} aria-pressed={toggle ? s.on : undefined} aria-label={LABEL[id]} disabled={!s.enabled} onClick={act[id]}>
        {TB_ICONS[id]}
        <span className="tb-label">{LABEL[id]}</span>
      </button>
    );
  };
  return (
    <div className="model-tools" data-testid="model-tools" data-layout={p.layout} role="toolbar" aria-label="Camera tools" aria-orientation={p.layout === "rail" ? "vertical" : "horizontal"}>
      {TOOLBAR_GROUPS.map((g) => (
        <div key={g.id} className={`tb-group tb-${g.id}`} role="group" aria-label={g.id === "view" ? "View" : g.id === "modes" ? "Mode" : "Tools"}>
          {g.id === "tools" ? (
            <ToolsMenu open={p.menuOpen} panel={p.panel} active={p.toolActive} disabled={!st.tools.enabled} layout={p.layout} onToggle={p.onToggleMenu} onPick={p.onPickTool} />
          ) : (
            g.items.map((i) => button(i as Exclude<ToolbarItem, "tools">))
          )}
        </div>
      ))}
      {!p.measuring && p.measureCount > 0 && (
        <div className="tb-group tb-list">
          <button type="button" className="tb-btn" data-testid="model-measure-list" aria-label={`Measures (${p.measureCount})`} onClick={p.onMeasureList}>
            {TB_ICONS.list}
            <span className="tb-label">Measures ({p.measureCount})</span>
          </button>
        </div>
      )}
    </div>
  );
}
