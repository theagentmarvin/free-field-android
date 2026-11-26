import { execFileSync } from "node:child_process";
import { PKG } from "../app";

const serial = () => process.env.ANDROID_SERIAL ?? "emulator-5554";
const adb = (...args: string[]) => execFileSync("adb", ["-s", serial(), ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

export interface MemSnapshot {
  label: string;
  /** TOTAL PSS of the app process (Java heap, native, graphics of the Activity). */
  appPssMb: number;
  /** Sum of the WebView renderer / GPU helper processes (where fragments, canvases and WebGL live). */
  rendererPssMb: number;
  /** appPss + rendererPss. */
  totalPssMb: number;
  /** Device-wide free memory (MemAvailable) in MB. */
  memAvailableMb: number;
  jsHeapMb: number | null;
  appPid: string;
  /** pid of the WebView sandboxed renderer: a change between snapshots means it was killed and respawned. */
  rendererPid: string;
  /** `dumpsys meminfo <pid>` breakdown (MB) of the renderer, with swap: PSS alone understates a swapping process by about 2x. */
  renderer?: MemBreakdown;
  /** Same for the app process (the WebView GPU side lives here: Graphics, GL/EGL mtrack). */
  app?: MemBreakdown;
  /** Worker JS heaps (MB), from `page.workers()`; null when unavailable. */
  workerHeapsMb?: Array<number | null>;
}

/** Rows of `dumpsys meminfo <pid>` that matter for the WebView memory budget, in MB. */
export interface MemBreakdown {
  totalPss: number;
  swapPss: number;
  nativeHeap: number;
  dalvikHeap: number;
  graphics: number;
  glMtrack: number;
  eglMtrack: number;
  /** Private dirty + clean of "Other mmap"/"Unknown" are folded into `other`: everything not named above. */
  other: number;
}

/**
 * Parse the text of `dumpsys meminfo <pid>`. Row lines are `Name  Pss  PrivDirty  PrivClean  SwapPssDirty  Rss ...`;
 * the App Summary block has `Graphics:  N`; `TOTAL SWAP PSS:` carries the process swap total. Values are kB in, MB out.
 */
export function parseMeminfoBreakdown(text: string): MemBreakdown {
  const row = (name: string): number[] | null => {
    const m = new RegExp(`^\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+((?:\\d+\\s*)+)$`, "m").exec(text);
    return m ? m[1].trim().split(/\s+/).map(Number) : null;
  };
  const summary = (name: string): number => Number(new RegExp(`^\\s*${name}:\\s+(\\d+)`, "m").exec(text)?.[1] ?? 0);
  const mb = (kb: number) => Math.round(kb / 1024);
  const native = row("Native Heap")?.[0] ?? summary("Native Heap");
  const dalvik = row("Dalvik Heap")?.[0] ?? summary("Java Heap");
  const gl = row("GL mtrack")?.[0] ?? 0;
  const egl = row("EGL mtrack")?.[0] ?? 0;
  const graphics = summary("Graphics");
  const total = Number(/TOTAL PSS:\s+(\d+)/.exec(text)?.[1] ?? row("TOTAL")?.[0] ?? 0);
  const swap = Number(/TOTAL SWAP PSS:\s+(\d+)/.exec(text)?.[1] ?? row("TOTAL")?.[3] ?? 0);
  return {
    totalPss: mb(total),
    swapPss: mb(swap),
    nativeHeap: mb(native),
    dalvikHeap: mb(dalvik),
    graphics: mb(graphics),
    glMtrack: mb(gl),
    eglMtrack: mb(egl),
    other: mb(Math.max(0, total - native - dalvik - graphics - gl - egl)),
  };
}

/** Breakdown of one pid; null when it cannot be dumped. */
export function pidBreakdown(pid: string): MemBreakdown | undefined {
  if (!/^\d+$/.test(pid)) return undefined;
  try {
    return parseMeminfoBreakdown(adb("shell", `dumpsys meminfo ${pid}`));
  } catch {
    return undefined;
  }
}

/** `dumpsys meminfo` of the app and of the WebView helper processes plus /proc/meminfo. Never throws. */
export function memSnapshot(label: string, jsHeapMb: number | null): MemSnapshot {
  let app = 0;
  let renderer = 0;
  try {
    const own = adb("shell", `dumpsys meminfo ${PKG}`);
    app = Number(/TOTAL PSS:\s+(\d+)/.exec(own)?.[1] ?? /^\s*TOTAL\s+(\d+)/m.exec(own)?.[1] ?? 0);
    // only the "Total PSS by process:" section (the dump repeats each process in several sections)
    const dump = adb("shell", "dumpsys meminfo");
    const start = dump.indexOf("Total PSS by process:");
    const section = start >= 0 ? dump.slice(start).split(/\n\s*\n/)[0] : "";
    for (const line of section.split("\n")) {
      // the WebView renderer (`com.google.android.webview:sandboxed_process0:...`): the only WebView client on the AVD is this app
      if (/:sandboxed_process\d+:/i.test(line)) {
        const m = /^\s*([\d,]+)K:\s/.exec(line);
        if (m) renderer += Number(m[1].replace(/,/g, ""));
      }
    }
  } catch {
    /* transient adb failure */
  }
  let avail = 0;
  try {
    avail = Number(/MemAvailable:\s+(\d+)/.exec(adb("shell", "cat /proc/meminfo"))?.[1] ?? 0);
  } catch {
    /* ignore */
  }
  let pid = "";
  try {
    pid = adb("shell", `pidof ${PKG}`).trim();
  } catch {
    /* not running */
  }
  let rendererPid = "";
  try {
    rendererPid = adb("shell", "ps -A").split("\n").find((l) => /:sandboxed_process\d+:/.test(l))?.trim().split(/\s+/)[1] ?? "";
  } catch {
    /* ignore */
  }
  const mb = (kb: number) => Math.round(kb / 1024);
  return { label, appPssMb: mb(app), rendererPssMb: mb(renderer), totalPssMb: mb(app + renderer), memAvailableMb: mb(avail), jsHeapMb, appPid: pid, rendererPid, renderer: pidBreakdown(rendererPid), app: pidBreakdown(pid) };
}

/** Kernel/OS kill and OOM lines mentioning this app since boot (`logcat -d`). */
export function oomLines(): string[] {
  try {
    return adb("logcat", "-d", "-v", "brief")
      .split("\n")
      .filter((l) => /lmkd.*(Kill|kill)ing|Killing '[^']*(freefield|webview|sandboxed)|Out of memory|OutOfMemoryError|Process app\.freefield\.field.* has died|Fatal signal.*(freefield|sandboxed)|Low on memory/i.test(l))
      .slice(-20);
  } catch {
    return [];
  }
}

/** App crashes, ANRs and WebView renderer deaths in the log (for failure diagnosis). */
export function crashLines(): string[] {
  try {
    return adb("logcat", "-d", "-v", "brief")
      .split("\n")
      .filter((l) => /FATAL EXCEPTION|ANR in app\.freefield|Process app\.freefield\.field.*died|Render process gone|renderer.*(crash|gone)|Fatal signal/i.test(l))
      .slice(-15);
  } catch {
    return [];
  }
}

/** Wide net for "the WebView or the app was killed": lmkd / ActivityManager kills, renderer-gone, chromium crash and tombstone lines. */
export function killLines(): string[] {
  try {
    return adb("logcat", "-d", "-v", "brief")
      .split("\n")
      .filter((l) => /render process gone|renderer process|RenderProcessGone|sandboxed_process.*(died|kill|crash)|lmkd.*(killing|Kill)|Killing \d+:|am_kill|am_proc_died|Process .*(sandboxed|webview|freefield).* (has died|died)|Fatal signal|SIGKILL|chromium.*(crash|FATAL)|ChildProcessLauncher.*(died|kill)/i.test(l))
      .slice(-25);
  } catch {
    return [];
  }
}

/** JS heap (MB, used) of every dedicated worker of the page (the fragments workers), via the worker's own `performance.memory`. */
export async function workerHeaps(page: import("@playwright/test").Page): Promise<Array<number | null>> {
  return Promise.all(
    page.workers().map((w) =>
      Promise.race([
        w.evaluate(() => ((performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0) / 1048576).then((v) => Math.round(v)),
        new Promise<null>((r) => setTimeout(() => r(null), 5000)),
      ]).catch(() => null),
    ),
  );
}

/** Raw `dumpsys meminfo <pid>` text (kept next to the report so a parse miss can be checked). */
export function rawMeminfo(pid: string): string {
  if (!/^\d+$/.test(pid)) return "";
  try {
    return adb("shell", `dumpsys meminfo ${pid}`);
  } catch {
    return "";
  }
}
