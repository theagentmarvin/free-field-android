import { TB_ICONS } from "./toolbarIcons";
import type { ToolbarLayout } from "./toolbarLayout";

export type ToolPanel = "section" | "filters" | "tree" | "search" | "views";

/** Panels that are listed in the Tools menu (the filters have their own toolbar button). */
type MenuTool = Exclude<ToolPanel, "filters">;

const ITEMS: Array<{ id: MenuTool; label: string; hint: string }> = [
  { id: "section", label: "Section", hint: "Section box and planes" },
  { id: "tree", label: "Model tree", hint: "Building, storeys, categories, elements" },
  { id: "search", label: "Search", hint: "Name, type, GlobalId or property value" },
  { id: "views", label: "Saved views", hint: "Save and restore camera, filters and section" },
];

interface Props {
  open: boolean;
  panel: ToolPanel | null;
  /** a tool changes what is drawn (shows a dot on the button) */
  active: boolean;
  disabled: boolean;
  layout?: ToolbarLayout;
  onToggle: () => void;
  onPick: (p: MenuTool) => void;
}

/** The "Tools" button of the camera column and its menu: the 3D tools live behind one button so the screen stays clear. */
export function ToolsMenu({ open, panel, active, disabled, layout = "rail", onToggle, onPick }: Props) {
  return (
    <div className="tools-menu-wrap" data-layout={layout}>
      <button type="button" className={`tb-btn${open || panel ? " is-on" : ""}`} data-testid="model-tools-button" aria-expanded={open} aria-haspopup="menu" aria-label="Tools" disabled={disabled} onClick={onToggle}>
        {TB_ICONS.tools}
        <span className="tb-label">Tools</span>
        {active && <span className="tools-dot" data-testid="tools-active-dot" aria-label="a tool is changing the view" />}
      </button>
      {open && (
        <div className="tools-menu" role="menu" data-testid="tools-menu">
          {ITEMS.map((it) => (
            <button key={it.id} type="button" role="menuitem" className={`tools-item${panel === it.id ? " is-on" : ""}`} data-testid={`tool-${it.id}`} onClick={() => onPick(it.id)}>
              <strong>{it.label}</strong>
              <span className="muted small-text">{it.hint}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
