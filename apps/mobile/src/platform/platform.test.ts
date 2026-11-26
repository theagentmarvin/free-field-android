// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { __setNetworkForTest, onOnlineChange, startNetworkMonitor } from "./network";
import { isTabletWidth, TABLET_MIN_DP } from "./useBreakpoint";

describe("tablet breakpoint", () => {
  it("splits at 840dp", () => {
    expect(TABLET_MIN_DP).toBe(840);
    expect(isTabletWidth(839)).toBe(false);
    expect(isTabletWidth(840)).toBe(true);
  });
});

describe("network bridge", () => {
  it("mirrors connectivity changes as window online/offline events", () => {
    startNetworkMonitor();
    const offline = vi.fn();
    const online = vi.fn();
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    __setNetworkForTest({ connected: false, connectionType: "none" });
    expect(offline).toHaveBeenCalledTimes(1);
    __setNetworkForTest({ connected: false, connectionType: "none" }); // no change, no event
    expect(offline).toHaveBeenCalledTimes(1);
    __setNetworkForTest({ connected: true, connectionType: "wifi" });
    expect(online).toHaveBeenCalledTimes(1);
  });
});

describe("network bridge (outbox support)", () => {
  it("makes navigator.onLine follow the OS connectivity", () => {
    startNetworkMonitor();
    __setNetworkForTest({ connected: false, connectionType: "none" });
    expect(navigator.onLine).toBe(false);
    __setNetworkForTest({ connected: true, connectionType: "wifi" });
    expect(navigator.onLine).toBe(true);
  });
  it("onOnlineChange fires on flips only, not on connection-type changes", () => {
    startNetworkMonitor();
    __setNetworkForTest({ connected: true, connectionType: "wifi" });
    const cb = vi.fn();
    const off = onOnlineChange(cb);
    __setNetworkForTest({ connected: true, connectionType: "cellular" });
    expect(cb).not.toHaveBeenCalled();
    __setNetworkForTest({ connected: false, connectionType: "none" });
    __setNetworkForTest({ connected: true, connectionType: "wifi" });
    expect(cb.mock.calls).toEqual([[false], [true]]);
    off();
    __setNetworkForTest({ connected: false, connectionType: "none" });
    expect(cb).toHaveBeenCalledTimes(2);
  });
});
