import { forwardRef, useImperativeHandle, useRef } from "react";
import type { TaskPin } from "@ff/tasks-react";
import { projectToScreen, type CameraPose } from "./viewMath";

export interface PinLayerHandle {
  /** Re-project every pin for `pose` in a `w` x `h` viewport. Writes styles directly: no React render per frame. */
  update(pose: CameraPose, w: number, h: number): number;
}

interface Props {
  pins: readonly TaskPin[];
  focusedId: string | null;
  onOpen: (taskId: string) => void;
}

const PIN_HALF = 22;

/** Screen-space DOM markers for task pins; positions come from {@link PinLayerHandle.update}. */
export const PinLayer = forwardRef<PinLayerHandle, Props>(function PinLayer({ pins, focusedId, onOpen }, ref) {
  const els = useRef(new Map<string, HTMLButtonElement>());
  useImperativeHandle(
    ref,
    () => ({
      update(pose, w, h) {
        let visible = 0;
        for (const p of pins) {
          const el = els.current.get(p.taskId);
          if (!el) continue;
          const s = projectToScreen(p.worldPoint, pose, w, h, PIN_HALF);
          if (!s || !s.onScreen) {
            if (el.dataset.visible !== "false") {
              el.dataset.visible = "false";
              el.style.display = "none";
            }
            continue;
          }
          visible++;
          if (el.dataset.visible !== "true") {
            el.dataset.visible = "true";
            el.style.display = "";
          }
          el.style.transform = `translate3d(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px, 0)`;
        }
        return visible;
      },
    }),
    [pins],
  );
  return (
    <div className="model-pins" data-testid="model-pins">
      {pins.map((p) => (
        <button
          key={p.taskId}
          type="button"
          ref={(el) => {
            if (el) els.current.set(p.taskId, el);
            else els.current.delete(p.taskId);
          }}
          className={`model-pin${p.pending ? " is-pending" : ""}${focusedId === p.taskId ? " is-focused" : ""}`}
          style={{ display: "none" }}
          data-testid="model-pin"
          data-task-id={p.taskId}
          data-num={p.num}
          data-visible="false"
          aria-label={`Task ${p.num}: ${p.title}`}
          onClick={() => onOpen(p.taskId)}
        >
          <span className="model-pin-dot">{p.num > 0 ? p.num : "•"}</span>
        </button>
      ))}
    </div>
  );
});
