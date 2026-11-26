import { describe, expect, it } from "vitest";
import { OverlayScheduler } from "./overlayScheduler";

function harness(idleFrames = 3) {
  let rev = 0;
  const queue = new Map<number, () => void>();
  let next = 1;
  const frames: boolean[] = [];
  const s = new OverlayScheduler({
    raf: (cb) => {
      queue.set(next, cb);
      return next++;
    },
    caf: (id) => void queue.delete(id),
    revision: () => rev,
    onFrame: (c) => frames.push(c),
    idleFrames,
  });
  const step = () => {
    const [id, cb] = [...queue][0] ?? [];
    if (id === undefined) return false;
    queue.delete(id);
    cb!();
    return true;
  };
  return { s, frames, step, queue, bump: () => rev++ };
}

describe("OverlayScheduler", () => {
  it("schedules nothing until kicked", () => {
    const h = harness();
    expect(h.queue.size).toBe(0);
    expect(h.s.running).toBe(false);
  });

  it("stops by itself after the idle window and leaves nothing queued", () => {
    const h = harness(3);
    h.s.kick();
    let n = 0;
    while (h.step()) n++;
    expect(n).toBe(4); // first frame sees the (initial) change, then 3 idle frames
    expect(h.s.running).toBe(false);
    expect(h.queue.size).toBe(0);
  });

  it("keeps running while the camera moves", () => {
    const h = harness(2);
    h.s.kick();
    for (let i = 0; i < 10; i++) {
      h.bump();
      h.step();
    }
    expect(h.s.running).toBe(true);
    expect(h.frames.every(Boolean)).toBe(true);
    while (h.step());
    expect(h.s.running).toBe(false);
  });

  it("does not start a second loop when kicked while running", () => {
    const h = harness();
    h.s.kick();
    h.s.kick();
    h.s.kick();
    expect(h.queue.size).toBe(1);
    expect(h.s.runs).toBe(1);
  });

  it("kick(true) reports a change although the camera is still (pin list changed)", () => {
    const h = harness(1);
    h.s.kick();
    while (h.step());
    h.frames.length = 0;
    h.s.kick(true);
    h.step();
    expect(h.frames).toEqual([true]);
    expect(h.s.runs).toBe(2);
  });

  it("a kick extends the idle window", () => {
    const h = harness(3);
    h.s.kick();
    h.step();
    h.step();
    h.s.kick();
    let n = 0;
    while (h.step()) n++;
    expect(n).toBe(3);
  });

  it("wakeIfChanged: no run for a camera change the loop already drew; a run for a new one", () => {
    const h = harness(3);
    h.s.kick();
    h.step();
    h.bump(); // the camera moves while the loop runs: the loop draws it
    while (h.step());
    const runs = h.s.runs;
    expect(h.s.wakeIfChanged()).toBe(false);
    expect(h.s.runs).toBe(runs);
    h.bump(); // a move nobody announced
    expect(h.s.wakeIfChanged()).toBe(true);
    expect(h.s.runs).toBe(runs + 1);
    h.step();
    expect(h.frames.at(-1)).toBe(true);
    expect(h.s.wakeIfChanged()).toBe(false); // already running
  });

  it("dispose cancels the pending frame and ignores later kicks", () => {
    const h = harness();
    h.s.kick();
    h.s.dispose();
    expect(h.queue.size).toBe(0);
    h.s.kick();
    expect(h.queue.size).toBe(0);
  });
});
