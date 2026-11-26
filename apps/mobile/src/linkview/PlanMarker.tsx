import { useRef } from "react";
import { pageToScreen, screenToPage, type PageSize, type View } from "../plans/viewMath";
import { clampToPage, type PagePt, type PlanMarker as Marker } from "./sync";

export interface PlanMarkerProps {
  view: View | null;
  page: PageSize;
  marker: Marker;
  /** The body was dragged (or the plan was tapped): stand at this page point. */
  onMove: (p: PagePt) => void;
  /** The wedge handle was dragged: look along this page heading (radians, 0 = +x, clockwise positive). */
  onTurn: (heading: number) => void;
}

const WEDGE_R = 64; // px, length of the view wedge
const WEDGE_HALF = (32 * Math.PI) / 180; // half of the 64 degree field drawn
const HANDLE_R = 70; // px from the dot to the centre of the turn handle

/**
 * "You are here" on the plan: a dot with a view wedge and a handle at the wedge's tip. Dragging the handle turns the view
 * (the 3D pane follows), dragging the dot moves it. Everything is a DOM / SVG layer above the tile canvas; the gesture
 * layer of the viewer ignores it (`data-nogesture`).
 */
export function PlanMarker({ view, page, marker, onMove, onTurn }: PlanMarkerProps) {
  const drag = useRef<{ id: number; kind: "turn" | "move" } | null>(null);
  if (!view) return null;
  const c = pageToScreen(view, marker.page);
  // Screen heading of the wedge: map the page direction through the view matrix (it may be rotated by quarter turns).
  const tip = pageToScreen(view, { x: marker.page.x + Math.cos(marker.heading), y: marker.page.y + Math.sin(marker.heading) });
  const ang = Math.atan2(tip.y - c.y, tip.x - c.x);
  const deg = (ang * 180) / Math.PI;

  const local = (e: React.PointerEvent) => {
    const r = (e.currentTarget.closest(".plan-viewer") as HTMLElement | null)?.getBoundingClientRect();
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
  };
  const apply = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const p = local(e);
    if (d.kind === "turn") {
      // Direction from the dot to the finger, as a heading on the page (through the inverse view).
      const a = screenToPage(view, { x: c.x, y: c.y });
      const b = screenToPage(view, p);
      if (Math.hypot(b.x - a.x, b.y - a.y) > 1e-6) onTurn(Math.atan2(b.y - a.y, b.x - a.x));
    } else {
      onMove(clampToPage(screenToPage(view, p), page));
    }
  };
  const start = (kind: "turn" | "move") => (e: React.PointerEvent) => {
    e.stopPropagation();
    drag.current = { id: e.pointerId, kind };
    e.currentTarget.setPointerCapture(e.pointerId);
    apply(e);
  };
  const end = (e: React.PointerEvent) => {
    if (drag.current?.id === e.pointerId) drag.current = null;
  };

  const a0 = -WEDGE_HALF;
  const a1 = WEDGE_HALF;
  const wedge = `M0 0 L${(WEDGE_R * Math.cos(a0)).toFixed(1)} ${(WEDGE_R * Math.sin(a0)).toFixed(1)} A${WEDGE_R} ${WEDGE_R} 0 0 1 ${(WEDGE_R * Math.cos(a1)).toFixed(1)} ${(WEDGE_R * Math.sin(a1)).toFixed(1)} Z`;

  return (
    <div className="lv-marker-layer" aria-hidden={false}>
      <div
        className="lv-marker"
        data-testid="lv-marker"
        data-page-x={marker.page.x.toFixed(1)}
        data-page-y={marker.page.y.toFixed(1)}
        data-heading-deg={((marker.heading * 180) / Math.PI).toFixed(1)}
        data-screen-x={c.x.toFixed(1)}
        data-screen-y={c.y.toFixed(1)}
        style={{ transform: `translate(${c.x}px, ${c.y}px)` }}
      >
        <svg className="lv-wedge" width={WEDGE_R * 2 + 8} height={WEDGE_R * 2 + 8} viewBox={`${-WEDGE_R - 4} ${-WEDGE_R - 4} ${WEDGE_R * 2 + 8} ${WEDGE_R * 2 + 8}`} style={{ transform: `rotate(${deg}deg)` }} aria-hidden="true">
          <path d={wedge} className="lv-wedge-fill" />
        </svg>
        <button type="button" className="lv-handle" data-nogesture data-testid="lv-handle" aria-label="Turn the view" style={{ transform: `translate(${(HANDLE_R * Math.cos(ang)).toFixed(1)}px, ${(HANDLE_R * Math.sin(ang)).toFixed(1)}px)` }} onPointerDown={start("turn")} onPointerMove={apply} onPointerUp={end} onPointerCancel={end}>
          <span className="lv-handle-dot" />
        </button>
        <button type="button" className="lv-dot" data-nogesture data-testid="lv-dot" aria-label="Move here" onPointerDown={start("move")} onPointerMove={apply} onPointerUp={end} onPointerCancel={end}>
          <span className="lv-dot-core" />
        </button>
      </div>
    </div>
  );
}
