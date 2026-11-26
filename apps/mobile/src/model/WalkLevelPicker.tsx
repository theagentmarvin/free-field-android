import { useState } from "react";
import { levelIndexFor, type WalkLevel } from "./walkLevels";

interface Props {
  levels: readonly WalkLevel[];
  /** Elevation of the floor the walker stands on. */
  floorY: number;
  onPick: (level: WalkLevel) => void;
}

const metres = (v: number) => `${v >= 0 ? "+" : "-"}${Math.abs(v).toFixed(2)} m`;

/**
 * Walk HUD level control: the current level's name (button, opens a compact list) with up / down steppers. Picking a level
 * teleports the eye to that storey's elevation + eye height, keeping the x/z position and heading.
 */
export function WalkLevelPicker({ levels, floorY, onPick }: Props) {
  const [open, setOpen] = useState(false);
  if (levels.length === 0) return null;
  const idx = levelIndexFor(levels, floorY);
  const cur = levels[idx];
  const stop = (e: React.PointerEvent) => e.stopPropagation();
  return (
    <div className="walk-level" data-testid="walk-levels" onPointerDown={stop}>
      <div className="walk-level-row">
        <button type="button" className="tb-step" data-testid="walk-level-down" aria-label="Level below" disabled={idx <= 0} onClick={() => onPick(levels[idx - 1])}>
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
        </button>
        <button type="button" className="walk-level-btn" data-testid="walk-level" data-level={cur?.name ?? ""} data-elevation={cur?.elevation ?? ""} aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <span className="walk-level-cap muted">Level</span>
          <strong className="walk-level-name" data-testid="walk-level-name">{cur?.name ?? "-"}</strong>
        </button>
        <button type="button" className="tb-step" data-testid="walk-level-up" aria-label="Level above" disabled={idx < 0 || idx >= levels.length - 1} onClick={() => onPick(levels[idx + 1])}>
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 15l6-6 6 6" /></svg>
        </button>
      </div>
      {open && (
        <>
          <div className="walk-level-scrim" data-testid="walk-level-scrim" onClick={() => setOpen(false)} />
          <ul className="walk-level-list" role="listbox" aria-label="Levels" data-testid="walk-level-list">
            {[...levels].map((l, i) => ({ l, i })).reverse().map(({ l, i }) => (
              <li key={`${l.name}:${l.elevation}`} role="none">
                <button type="button" role="option" aria-selected={i === idx} className={`walk-level-opt${i === idx ? " is-on" : ""}`} data-testid="walk-level-option" data-level={l.name} data-elevation={l.elevation} onClick={() => { setOpen(false); onPick(l); }}>
                  <span className="grow">{l.name}</span>
                  <span className="muted small-text">{metres(l.elevation)}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
