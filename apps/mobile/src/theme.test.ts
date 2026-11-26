import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");
const tokensCss = read("vendor/free-field/apps/settings/src/styles/tokens.css");
const mobileCss = [
  "apps/mobile/src/styles.css",
  "apps/mobile/src/tasks/tasks.css",
  "apps/mobile/src/model/model.css",
].map(read);
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "");

function parseVars(css: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const x of stripComments(css).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) m.set(x[1]!, x[2]!.trim());
  return m;
}
const ff = parseVars(tokensCss);
const mobile = parseVars(mobileCss[0]!);

/** Follow var() aliases until a literal; returns the --ff token it bottoms out on. */
function resolveToken(name: string): { token?: string; value: string } {
  let cur = name;
  let token: string | undefined;
  for (let i = 0; i < 6; i++) {
    const v = (mobile.get(cur) ?? ff.get(cur))!;
    const ref = /^var\((--[\w-]+)\)$/.exec(v);
    if (!ref) return { token, value: v };
    cur = ref[1]!;
    if (cur.startsWith("--ff-")) token = cur;
  }
  throw new Error(`alias loop at ${name}`);
}

describe("light theme token mapping", () => {
  it("maps the mobile root onto the web tokens", () => {
    const expected: Record<string, string> = {
      "--bg": "--ff-bg-app",
      "--panel": "--ff-bg-app",
      "--panel-2": "--ff-bg-panel",
      "--canvas": "--ff-bg-canvas",
      "--line": "--ff-border",
      "--text": "--ff-text-primary",
      "--muted": "--ff-text-secondary",
      "--accent": "--ff-blue-active",
    };
    for (const [k, t] of Object.entries(expected)) {
      expect(resolveToken(k).token, k).toBe(t);
      expect(resolveToken(k).value, k).toBe(ff.get(t));
    }
    expect(resolveToken("--ff-bg-app").value).toBe("#ffffff");
    expect(resolveToken("--ff-bg-canvas").value).toBe("#f2f3f4");
    expect(resolveToken("--bg").value).toBe("#ffffff");
  });

  it("is light only", () => {
    const css = stripComments(mobileCss.join("\n"));
    expect(mobile.get("color-scheme")).toBeUndefined(); // set as a property, not a variable
    expect(css).toMatch(/color-scheme:\s*light/);
    expect(css).not.toMatch(/prefers-color-scheme/);
    expect(css).not.toMatch(/color-scheme:\s*dark/);
  });

  it("holds no hand-copied hex colours (everything resolves to a token)", () => {
    for (const css of mobileCss) expect(stripComments(css).match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);
  });

  it("keeps the touch size at 44px", () => {
    expect(mobile.get("--touch")).toBe("44px");
  });

  it("keeps the Android colours in step with the tokens", () => {
    const xml = read("apps/mobile/android/app/src/main/res/values/ff_colors.xml");
    const color = (n: string) => new RegExp(`name="${n}">(#[0-9a-fA-F]{6})<`).exec(xml)?.[1]?.toLowerCase();
    expect(color("ff_bg_app")).toBe(ff.get("--ff-bg-app"));
    expect(color("ff_bg_canvas")).toBe(ff.get("--ff-bg-canvas"));
    expect(color("ff_blue_active")).toBe(ff.get("--ff-blue-active"));
  });
});

describe("AA contrast of the text colour pairs", () => {
  const lin = (c: number) => (c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  const lum = (hex: string) => {
    const n = parseInt(hex.slice(1), 16);
    return 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  };
  const ratio = (a: string, b: string) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x! + 0.05) / (y! + 0.05);
  };
  const v = (n: string) => resolveToken(n).value;
  const pairs: [string, string][] = [
    ["--text", "--bg"], ["--muted", "--bg"], ["--text", "--panel-2"], ["--text", "--selected"],
    ["--on-accent", "--accent"], ["--on-accent", "--danger"], ["--accent", "--bg"],
    ["--ok", "--ok-bg"], ["--warn", "--warn-bg"], ["--danger-text", "--danger-bg"],
    ["--info", "--info-bg"], ["--danger", "--bg"], ["--ok", "--bg"], ["--warn", "--bg"],
  ];
  it.each(pairs)("%s on %s is at least 4.5:1", (fg, bg) => {
    expect(ratio(v(fg), v(bg))).toBeGreaterThanOrEqual(4.5);
  });
});
