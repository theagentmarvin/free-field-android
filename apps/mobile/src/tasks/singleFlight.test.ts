import { describe, expect, it } from "vitest";
import { singleFlight } from "./singleFlight";

describe("singleFlight", () => {
  it("drops calls made while one is in flight and allows the next one afterwards", async () => {
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const send = singleFlight(async () => {
      runs += 1;
      await gate;
    });
    const a = send();
    const b = send();
    const c = send();
    release();
    await Promise.all([a, b, c]);
    expect(runs).toBe(1);
    await send();
    expect(runs).toBe(2);
  });

  it("is released when the call throws", async () => {
    let runs = 0;
    const send = singleFlight(async () => {
      runs += 1;
      throw new Error("boom");
    });
    await expect(send()).rejects.toThrow("boom");
    await expect(send()).rejects.toThrow("boom");
    expect(runs).toBe(2);
  });
});
