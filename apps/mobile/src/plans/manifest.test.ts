import { describe, expect, it } from "vitest";
import { buildManifest, manifestKey, parseManifest, sameLayout, serializeManifest, tileKey, tilePrefix } from "./manifest";
import { assertValidKey } from "../storage";

describe("manifest", () => {
  const m = buildManifest("ver-1", "abc", 2384, 1684, undefined, 1000);
  it("keys follow the tiles/{id}/{z}/{x}_{y}.webp layout and are valid BlobStore keys", () => {
    expect(tilePrefix("ver-1")).toBe("tiles/ver-1/");
    expect(manifestKey("ver-1")).toBe("tiles/ver-1/manifest.json");
    expect(tileKey("ver-1", 3, 12, 7)).toBe("tiles/ver-1/3/12_7.webp");
    for (const k of [manifestKey("ver-1"), tileKey("ver-1", 3, 12, 7)]) expect(() => assertValidKey(k)).not.toThrow();
  });
  it("starts incomplete and round-trips", () => {
    expect(m.complete).toBe(false);
    expect(m.sha256).toBe("abc");
    expect(parseManifest(serializeManifest(m))).toEqual(m);
  });
  it("rejects garbage, wrong versions and bad geometry", () => {
    expect(parseManifest(null)).toBeNull();
    expect(parseManifest(new TextEncoder().encode("{nope"))).toBeNull();
    expect(parseManifest(new TextEncoder().encode(JSON.stringify({ ...m, v: 2 })))).toBeNull();
    expect(parseManifest(new TextEncoder().encode(JSON.stringify({ ...m, levels: [] })))).toBeNull();
    expect(parseManifest(new TextEncoder().encode(JSON.stringify({ ...m, pageWidth: 0 })))).toBeNull();
    expect(parseManifest(new TextEncoder().encode(JSON.stringify({ ...m, tileSize: 512 })))).toBeNull();
  });
  it("sameLayout compares hash and level geometry", () => {
    expect(sameLayout(m, buildManifest("ver-1", "abc", 2384, 1684))).toBe(true);
    expect(sameLayout(m, buildManifest("ver-1", "zzz", 2384, 1684))).toBe(false);
    expect(sameLayout(m, buildManifest("ver-1", "abc", 2000, 1684))).toBe(false);
    expect(sameLayout(m, buildManifest("ver-1", "abc", 2384, 1684, { maxLevels: 3 }))).toBe(false);
  });
});
