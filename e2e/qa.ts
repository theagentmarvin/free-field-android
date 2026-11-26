import { PKG, type AppSession } from "./app";

/**
 * Device-state helpers for the QA specs. Every knob a test turns has a matching entry in
 * `restoreDevice`, which the specs call from `afterAll` (and `afterEach` for the risky ones) so a failing
 * test cannot leave the emulator rotated, scaled, dark, skewed or full.
 */
export const FILLER = "/data/local/tmp/ffm-qa-filler";
export const APP_FILLER = `/data/data/${PKG}/files/ffm-qa-filler`;

export async function setRotation(app: AppSession, rot: 0 | 1 | 2 | 3): Promise<void> {
  // A physical device keeps its own rotation settings: portrait (0) is assumed as held, anything else is refused.
  if (process.env.FFM_ALLOW_DEVICE && rot === 0) return;
  await app.shell("settings put system accelerometer_rotation 0");
  await app.shell(`settings put system user_rotation ${rot}`);
}

export async function setFontScale(app: AppSession, scale: number | null): Promise<void> {
  await app.shell(scale === null ? "settings delete system font_scale" : `settings put system font_scale ${scale}`);
}

export async function setNight(app: AppSession, on: boolean): Promise<void> {
  await app.shell(`cmd uimode night ${on ? "yes" : "no"}`);
}

/** Root shell on the emulator (google_apis images allow it). Returns false when the device refuses. */
export async function tryRoot(app: AppSession): Promise<boolean> {
  const id = (await app.shell("id").catch(() => "")).trim();
  if (id.startsWith("uid=0")) return true;
  const { execFileSync } = await import("node:child_process");
  try {
    execFileSync("adb", ["-s", process.env.ANDROID_SERIAL ?? "emulator-5554", "root"], { encoding: "utf8" });
  } catch {
    return false;
  }
  await new Promise((r) => setTimeout(r, 2500));
  return true;
}

/** Everything a QA test may have changed, back to the harness defaults. Never throws. */
export async function restoreDevice(app: AppSession | undefined): Promise<void> {
  if (!app) return;
  const run = (c: string) => app.shell(c).catch(() => undefined);
  await run("settings put system accelerometer_rotation 1");
  await run("settings put system user_rotation 0");
  await run("settings delete system font_scale");
  await run("cmd uimode night no");
  await run("wm size reset");
  await run("wm density reset");
  await run("cmd connectivity airplane-mode disable");
  await run(`rm -f ${FILLER}*`);
  await run(`rm -f ${APP_FILLER}`);
  await run(`run-as ${PKG} rm -f files/ffm-qa-filler`);
  await run("settings put global auto_time 1");
  await run("settings put global auto_time_zone 1");
}
