import { describe, expect, it, vi } from "vitest";
import { exportLogs, logFileName } from "./exportLogs";
import { RingLogger } from "./logger";

const NOW = Date.UTC(2026, 10, 17, 12, 0, 0);

describe("exportLogs", () => {
  it("names the file after the timestamp without unsafe characters", () => {
    expect(logFileName(NOW)).toBe("ffm-logs-2026-11-17T12-00-00-000Z.txt");
  });
  it("writes header + entries and shares the file", async () => {
    const l = new RingLogger(10, () => NOW);
    l.info("one");
    l.error("two");
    const writeFile = vi.fn<(name: string, text: string) => Promise<string>>(async () => "file:///cache/x.txt");
    const share = vi.fn(async () => true);
    const r = await exportLogs(l, { writeFile, share, now: () => NOW }, ["app: 1.0"]);
    expect(r).toEqual({ name: "ffm-logs-2026-11-17T12-00-00-000Z.txt", uri: "file:///cache/x.txt", shared: true, lines: 2 });
    const text = writeFile.mock.calls[0][1] as string;
    expect(text).toContain("app: 1.0");
    expect(text).toContain("INFO  one");
    expect(text).toContain("ERROR two");
    expect(share).toHaveBeenCalledWith("file:///cache/x.txt", expect.any(String));
  });
  it("still returns the file when sharing fails or is dismissed", async () => {
    const r = await exportLogs(new RingLogger(), {
      writeFile: async () => "uri",
      share: async () => Promise.reject(new Error("cancelled")),
      now: () => NOW,
    });
    expect(r.shared).toBe(false);
    expect(r.uri).toBe("uri");
  });
  it("propagates a write failure", async () => {
    await expect(
      exportLogs(new RingLogger(), { writeFile: async () => Promise.reject(new Error("disk full")), share: async () => true, now: () => NOW }),
    ).rejects.toThrow("disk full");
  });
  it("does not wait for the share sheet to be dismissed", async () => {
    const r = await exportLogs(
      new RingLogger(),
      { writeFile: async () => "uri", share: () => new Promise<boolean>(() => undefined), now: () => NOW },
      [],
      10,
    );
    expect(r.shared).toBe(true);
  });
});
