import { useRef } from "react";
import type { WalkInput } from "./viewMath";

interface Props {
  onLook: (dxPx: number, dyPx: number) => void;
  onMove: (input: WalkInput) => void;
  onExit: () => void;
  /** Link view: first person is the only mode, so there is nothing to exit to. */
  hideExit?: boolean;
}

const PAD = 120; // px, joystick diameter
const R = PAD / 2;

/** First-person controls: drag anywhere to look, joystick (move pad) bottom-left to walk. Covers the canvas while active. */
export function WalkLayer({ onLook, onMove, onExit, hideExit = false }: Props) {
  const look = useRef<{ id: number; x: number; y: number } | null>(null);
  const knob = useRef<HTMLDivElement>(null);
  const stick = useRef<{ id: number; cx: number; cy: number } | null>(null);

  const setKnob = (dx: number, dy: number) => {
    if (knob.current) knob.current.style.transform = `translate(${dx}px, ${dy}px)`;
  };
  const moveStick = (e: React.PointerEvent) => {
    const s = stick.current;
    if (!s || e.pointerId !== s.id) return;
    let dx = e.clientX - s.cx;
    let dy = e.clientY - s.cy;
    const d = Math.hypot(dx, dy);
    if (d > R) {
      dx = (dx / d) * R;
      dy = (dy / d) * R;
    }
    setKnob(dx, dy);
    onMove({ forward: -dy / R, strafe: dx / R });
  };
  const endStick = (e: React.PointerEvent) => {
    if (stick.current?.id !== e.pointerId) return;
    stick.current = null;
    setKnob(0, 0);
    onMove({ forward: 0, strafe: 0 });
  };

  return (
    <div
      className="walk-layer"
      data-testid="walk-layer"
      onPointerDown={(e) => {
        if (look.current) return;
        look.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const l = look.current;
        if (!l || e.pointerId !== l.id) return;
        onLook(e.clientX - l.x, e.clientY - l.y);
        l.x = e.clientX;
        l.y = e.clientY;
      }}
      onPointerUp={(e) => {
        if (look.current?.id === e.pointerId) look.current = null;
      }}
      onPointerCancel={(e) => {
        if (look.current?.id === e.pointerId) look.current = null;
      }}
    >
      <div
        className="walk-pad"
        data-testid="walk-pad"
        onPointerDown={(e) => {
          e.stopPropagation();
          const r = e.currentTarget.getBoundingClientRect();
          stick.current = { id: e.pointerId, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
          e.currentTarget.setPointerCapture(e.pointerId);
          moveStick(e);
        }}
        onPointerMove={moveStick}
        onPointerUp={endStick}
        onPointerCancel={endStick}
      >
        <div className="walk-knob" ref={knob} />
      </div>
      {!hideExit && (
        <button type="button" className="btn walk-exit" data-testid="walk-exit" onPointerDown={(e) => e.stopPropagation()} onClick={onExit}>
          Exit walk
        </button>
      )}
      <p className="walk-hint muted">Drag to look · pad to walk · eye height 1.6 m</p>
    </div>
  );
}
