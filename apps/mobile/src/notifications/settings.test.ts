import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, getSettings, parseSettings, resetSettingsCache, updateSettings, type KV } from "./settings";

function memoryKV(): KV & { raw(): string | null } {
  const m = new Map<string, string>();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v), remove: (k) => void m.delete(k), raw: () => [...m.values()][0] ?? null };
}

describe("notification settings", () => {
  beforeEach(() => resetSettingsCache());

  it("defaults to everything on", () => {
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings("not json")).toEqual(DEFAULT_SETTINGS);
  });

  it("ignores wrong types and keeps valid fields", () => {
    expect(parseSettings(JSON.stringify({ master: false, status: "no", deadlines: false }))).toEqual({ ...DEFAULT_SETTINGS, master: false, deadlines: false });
  });

  it("persists updates", () => {
    const kv = memoryKV();
    updateSettings({ comments: false }, kv);
    expect(getSettings().comments).toBe(false);
    expect(JSON.parse(kv.raw()!)).toMatchObject({ comments: false, master: true });
  });
});
