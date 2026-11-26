import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { PKG, SHOTS, type AppSession } from "./app";

/** Minimal uiautomator driver for system UI (camera app, photo picker, permission dialogs). */
interface Node {
  text: string;
  desc: string;
  id: string;
  cx: number;
  cy: number;
  clickable: boolean;
  pkg: string;
}

export async function dumpUi(app: AppSession): Promise<Node[]> {
  await app.shell("uiautomator dump /sdcard/ffm-ui.xml");
  const xml = await app.shell("cat /sdcard/ffm-ui.xml");
  const nodes: Node[] = [];
  for (const m of xml.matchAll(/<node [^>]*>/g)) {
    const tag = m[0];
    const attr = (n: string) => new RegExp(`\\b${n}="([^"]*)"`).exec(tag)?.[1] ?? "";
    const b = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(tag);
    if (!b) continue;
    nodes.push({
      text: attr("text"),
      desc: attr("content-desc"),
      id: attr("resource-id"),
      cx: (Number(b[1]) + Number(b[3])) / 2,
      cy: (Number(b[2]) + Number(b[4])) / 2,
      clickable: attr("clickable") === "true",
      pkg: attr("package"),
    });
  }
  return nodes;
}

export type Matcher = RegExp;

function find(nodes: Node[], re: Matcher): Node | undefined {
  // the app's own WebView content is part of the hierarchy: only match foreign windows
  return nodes.filter((n) => n.pkg !== PKG).find((n) => re.test(n.text) || re.test(n.desc) || re.test(n.id));
}

/** Poll the UI until a node matching `re` (text, content-desc or resource id) exists, then tap it. */
export async function tapSys(app: AppSession, re: Matcher, timeoutMs = 30_000): Promise<string> {
  const end = Date.now() + timeoutMs;
  let last: Node[] = [];
  while (Date.now() < end) {
    last = await dumpUi(app);
    const n = find(last, re);
    if (n) {
      await app.shell(`input tap ${Math.round(n.cx)} ${Math.round(n.cy)}`);
      return n.id || n.text || n.desc;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  await snapUi(app, `fail-${Date.now()}`).catch(() => undefined);
  throw new Error(`system UI: nothing matched ${re}; saw: ${last.map((n) => n.id || n.text || n.desc).filter(Boolean).join(" | ")}`);
}

export async function sysVisible(app: AppSession, re: Matcher): Promise<boolean> {
  return !!find(await dumpUi(app), re);
}

/** Save the current system UI (hierarchy + screenshot) under test-results for debugging. */
export async function snapUi(app: AppSession, name: string): Promise<void> {
  const nodes = await dumpUi(app);
  writeFileSync(
    join(SHOTS, `ui-${name}.txt`),
    nodes.filter((n) => n.pkg !== PKG).map((n) => `${n.pkg} | ${n.id} | ${n.text} | ${n.desc} | ${Math.round(n.cx)},${Math.round(n.cy)}`).join("\n"),
  );
  await app.device.screenshot({ path: join(SHOTS, `ui-${name}.png`) }).catch(() => undefined);
}
