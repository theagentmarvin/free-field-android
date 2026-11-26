import { describe, expect, it, vi } from "vitest";
import { installConsoleCapture, RingLogger } from "./logger";

describe("RingLogger", () => {
  it("keeps only the newest `capacity` entries", () => {
    const l = new RingLogger(3, () => 0);
    for (let i = 1; i <= 5; i++) l.info(`m${i}`);
    expect(l.entries().map((e) => e.msg)).toEqual(["m3", "m4", "m5"]);
  });
  it("stringifies errors and objects, truncates long lines", () => {
    const l = new RingLogger(5, () => 0);
    l.error(new TypeError("bad"), { a: 1 });
    l.warn("x".repeat(5000));
    const [a, b] = l.entries();
    expect(a.msg).toBe('TypeError: bad {"a":1}');
    expect(b.msg.length).toBe(2000);
  });
  it("formats ISO time, level and message", () => {
    const l = new RingLogger(5, () => Date.UTC(2026, 0, 2, 3, 4, 5));
    l.warn("hello");
    expect(l.format()).toBe("2026-01-02T03:04:05.000Z WARN  hello");
  });
  it("rejects a zero capacity and clears", () => {
    expect(() => new RingLogger(0)).toThrow();
    const l = new RingLogger(2);
    l.info("a");
    l.clear();
    expect(l.entries()).toEqual([]);
  });
});

describe("installConsoleCapture", () => {
  it("mirrors console calls into the buffer, still calls the original, and uninstalls", () => {
    const orig = { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const c = { ...orig };
    const l = new RingLogger(10, () => 0);
    const listeners: Record<string, (e: Event) => void> = {};
    const uninstall = installConsoleCapture(l, c, { addEventListener: (t, cb) => void (listeners[t] = cb) });
    c.warn("careful", 1);
    c.error("bad");
    expect(orig.warn).toHaveBeenCalledWith("careful", 1);
    expect(l.entries().map((e) => `${e.level}:${e.msg}`)).toEqual(["warn:careful 1", "error:bad"]);
    listeners.error({ message: "boom" } as unknown as Event);
    listeners.unhandledrejection({ reason: new Error("rej") } as unknown as Event);
    expect(l.entries().slice(-2).map((e) => e.msg)).toEqual(["uncaught boom", "unhandled rejection Error: rej"]);
    uninstall();
    expect(c.warn).toBe(orig.warn);
  });
});
