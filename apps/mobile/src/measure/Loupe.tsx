import { useEffect, useRef } from "react";
import { loupePlacement } from "./loupe";

export const LOUPE_SIZE = 116;

interface Props {
  /** Aim position in CSS pixels, relative to the container. */
  aim: { x: number; y: number };
  bounds: { w: number; h: number };
  /** Paint the magnified area into the bubble's canvas (device pixels, `w` x `h`). */
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void;
  /** Optional caption under the bubble (snap kind, live value). */
  snap?: string | null;
  live?: string;
}

/** Magnifier bubble that follows the aiming finger, offset so the fingertip does not hide the point. */
export function Loupe({ aim, bounds, draw, snap, live }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const px = Math.round(LOUPE_SIZE * dpr);
  const pos = loupePlacement(aim, bounds, LOUPE_SIZE);
  useEffect(() => {
    const c = ref.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, px, px);
    try {
      draw(ctx, px, px);
    } catch {
      /* a source that cannot be read right now: the crosshair alone still marks the point */
    }
  });
  return (
    <div className="loupe" data-testid="measure-loupe" data-below={pos.below ? "1" : "0"} data-snap={snap ?? ""} data-live={live ?? ""} style={{ transform: `translate(${pos.x - LOUPE_SIZE / 2}px, ${pos.y - LOUPE_SIZE / 2}px)`, width: LOUPE_SIZE, height: LOUPE_SIZE }}>
      <div className="loupe-lens">
      <canvas ref={ref} width={px} height={px} />
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <line x1="50" y1="30" x2="50" y2="43" />
        <line x1="50" y1="57" x2="50" y2="70" />
        <line x1="30" y1="50" x2="43" y2="50" />
        <line x1="57" y1="50" x2="70" y2="50" />
        <circle cx="50" cy="50" r="2.2" />
      </svg>
      </div>
      {(snap || live) && (
        <div className="loupe-cap" data-testid="loupe-caption">
          {snap && <span className="loupe-snap">{snap}</span>}
          {live && <span className="loupe-live">{live}</span>}
        </div>
      )}
    </div>
  );
}
