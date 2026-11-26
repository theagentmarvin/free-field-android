import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveProps } from "./properties";

// the real module pulls pdf.js (needs DOM APIs); only the pset grouping helper is used here
vi.mock("@ff/viewer-react", () => ({ getPropertyGroups: () => null }));

afterEach(() => vi.useRealTimers());

describe("resolveProps", () => {
  it("shapes attributes and takes the guid from the viewer when the record has none", async () => {
    const s = await resolveProps(async () => ({ attributes: { Name: "Wall", _category: "IFCWALL" }, globalId: "G1" }), "Element 1");
    expect(s.status).toBe("ready");
    if (s.status === "ready") expect(s.props).toMatchObject({ title: "Wall", category: "IFCWALL", guid: "G1" });
  });
  it("ends in a readable error when nothing comes back", async () => {
    expect(await resolveProps(async () => null, "Element 1")).toEqual({ status: "error", reason: "none" });
  });
  it("ends in an error when the fetch rejects", async () => {
    expect(await resolveProps(() => Promise.reject(new Error("worker gone")), "Element 1")).toEqual({ status: "error", reason: "failed" });
  });
  it("ends in an error when the fetch never resolves", async () => {
    vi.useFakeTimers();
    const p = resolveProps(() => new Promise(() => undefined), "Element 1", 1000);
    await vi.advanceTimersByTimeAsync(1001);
    expect(await p).toEqual({ status: "error", reason: "timeout" });
  });
});
