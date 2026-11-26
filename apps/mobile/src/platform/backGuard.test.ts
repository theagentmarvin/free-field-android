import { afterEach, describe, expect, it } from "vitest";
import { runBackGuard, setBackGuard } from "./backGuard";

describe("back guard", () => {
  afterEach(() => setBackGuard(null));
  it("is not handled without a guard", () => {
    expect(runBackGuard()).toBe(false);
  });
  it("lets the guard handle the press", () => {
    let calls = 0;
    setBackGuard(() => {
      calls++;
      return true;
    });
    expect(runBackGuard()).toBe(true);
    expect(calls).toBe(1);
  });
  it("a guard that declines lets the app navigate", () => {
    setBackGuard(() => false);
    expect(runBackGuard()).toBe(false);
  });
  it("the returned disposer only removes its own guard", () => {
    const off1 = setBackGuard(() => true);
    setBackGuard(() => true);
    off1();
    expect(runBackGuard()).toBe(true);
  });
  it("a throwing guard never blocks Back", () => {
    setBackGuard(() => {
      throw new Error("boom");
    });
    expect(runBackGuard()).toBe(false);
  });
});
