import { execFileSync } from "node:child_process";
import { PKG } from "./app";

const serial = () => process.env.ANDROID_SERIAL ?? "emulator-5554";
export const adb = (...args: string[]) => execFileSync("adb", ["-s", serial(), ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

const pss = (out: string, re: RegExp) => {
  const m = re.exec(out);
  return m ? Number(m[1]) : 0;
};

/**
 * Samples PSS of the app process and of the WebView renderer (where pdf.js, canvases and workers live)
 * until stopped. Returns the peaks in MB.
 */
export function startMemorySampler(intervalMs = 1000) {
  let peakAppKb = 0;
  let peakRendererKb = 0;
  let running = true;
  const loop = (async () => {
    while (running) {
      try {
        const own = adb("shell", `dumpsys meminfo ${PKG}`);
        peakAppKb = Math.max(peakAppKb, pss(own, /TOTAL PSS:\s+(\d+)/) || pss(own, /TOTAL\s+(\d+)/));
        for (const line of adb("shell", "dumpsys meminfo").split("\n")) {
          if (/sandboxed_process|webview|chromium/i.test(line)) {
            const m = /^\s*([\d,]+)K:\s/.exec(line);
            if (m) peakRendererKb = Math.max(peakRendererKb, Number(m[1].replace(/,/g, "")));
          }
        }
      } catch {
        /* a transient adb failure must not fail the run */
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  })();
  return {
    async stop() {
      running = false;
      await loop;
      return { peakAppPssMb: Math.round(peakAppKb / 1024), peakRendererPssMb: Math.round(peakRendererKb / 1024) };
    },
  };
}

/** Copy a host file into the app's BlobStore root (debug build, run-as). */
export function pushToBlobStore(local: string, key: string): void {
  const tmp = `/data/local/tmp/${key.replace(/\//g, "_")}`;
  adb("push", local, tmp);
  const root = "files/blobs"; // Capacitor Directory.Data + CapacitorBlobStore root, relative to the app data dir
  const dir = key.includes("/") ? key.slice(0, key.lastIndexOf("/")) : "";
  if (dir) adb("shell", `run-as ${PKG} mkdir -p ${root}/${dir}`);
  adb("shell", `run-as ${PKG} cp ${tmp} ${root}/${key}`);
  adb("shell", `rm ${tmp}`);
}
