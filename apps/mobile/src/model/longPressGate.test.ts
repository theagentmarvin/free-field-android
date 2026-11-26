import { describe, expect, it } from "vitest";
import { LongPressGate } from "./longPressGate";

describe("LongPressGate", () => {
  it("clears the candidate on an ordinary tap", () => {
    const g = new LongPressGate();
    g.newGesture();
    expect(g.shouldClearCandidate()).toBe(true);
  });
  it("keeps the candidate for the release pick of the long-press, however late it arrives", () => {
    const g = new LongPressGate();
    g.newGesture();
    g.fired();
    expect(g.shouldClearCandidate()).toBe(false); // still false later: no time window
  });
  it("re-arms on the next touch", () => {
    const g = new LongPressGate();
    g.newGesture();
    g.fired();
    g.newGesture();
    expect(g.shouldClearCandidate()).toBe(true);
  });
});
