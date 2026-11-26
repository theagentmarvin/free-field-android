import { execFileSync } from "node:child_process";
import { test, type Page } from "@playwright/test";
import type { AppSession } from "../app";

/**
 * Real "offline" for the emulator lane.
 *
 * `cmd connectivity airplane-mode enable` flips the OS connectivity state but does NOT sever the
 * `adb reverse` tunnels the app uses to reach the Firebase emulators on the host, so Firestore/Auth/Storage
 * stay reachable and "offline" tests are invalid. `setOffline(true)` therefore also removes every reverse
 * mapping (remembering the exact list, including any per-spec proxy mapping), and `setOffline(false)`
 * restores that exact list and waits until the app is really back (probe through the tunnel + app chip).
 */
const SERIAL = () => process.env.ANDROID_SERIAL ?? "emulator-5554";
const adb = (...args: string[]) => execFileSync("adb", ["-s", SERIAL(), ...args], { encoding: "utf8" });

/** Parses `adb reverse --list` lines: `<serial> tcp:9199 tcp:29199` -> ["tcp:9199","tcp:29199"]. */
export function listReverse(): Array<[string, string]> {
  return adb("reverse", "--list")
    .split("\n")
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p.length >= 3 && p[1].startsWith("tcp:"))
    .map((p) => [p[1], p[2]] as [string, string]);
}

let saved: Array<[string, string]> | null = null;

export async function setOffline(_app: AppSession | undefined, on: boolean): Promise<void> {
  if (on) {
    if (saved === null) saved = listReverse(); // keep the original mappings across repeated offline(true)
    for (const [dev] of saved) {
      try {
        adb("reverse", "--remove", dev);
      } catch {
        /* already removed */
      }
    }
    adb("shell", "cmd", "connectivity", "airplane-mode", "enable");
    return;
  }
  adb("shell", "cmd", "connectivity", "airplane-mode", "disable");
  for (const [dev, host] of saved ?? []) adb("reverse", dev, host);
  saved = null;
}

/** Start every spec from a known-online device (a previous failed run may have left airplane mode on). */
export async function ensureOnline(): Promise<void> {
  const was = adb("shell", "settings", "get", "global", "airplane_mode_on").trim();
  if (was !== "0") console.log(`ensureOnline: airplane_mode_on was ${was}; disabling`);
  await setOffline(undefined, false);
}

/** Restore connectivity even if a test died halfway (afterAll). Never throws. */
export async function restoreNetwork(app: AppSession | undefined): Promise<void> {
  try {
    if (app) await setOffline(app, false);
  } catch {
    /* emulator gone */
  }
}

/** Cheap probe through the device's localhost tunnel to the Firestore emulator. */
export async function probeTunnel(page: Page): Promise<boolean> {
  return page
    .evaluate(async () => {
      try {
        const c = new AbortController();
        const t = setTimeout(() => c.abort(), 4000);
        await fetch("http://localhost:8080/", { mode: "no-cors", signal: c.signal, cache: "no-store" });
        clearTimeout(t);
        return true;
      } catch {
        return false;
      }
    })
    .catch(() => false);
}

/**
 * Go online and wait until the app is genuinely back: the tunnel answers and `indicator` (the sync chip or the
 * offline-page network line) no longer reports offline.
 */
export async function goOnline(app: AppSession, indicator: (page: Page) => Promise<boolean>, timeoutMs = 90_000): Promise<void> {
  await setOffline(app, false);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await probeTunnel(app.page)) && (await indicator(app.page).catch(() => false))) return;
    if (Date.now() > deadline) throw new Error("goOnline: app did not report online with a working tunnel in time");
    await new Promise((r) => setTimeout(r, 750));
  }
}

/** On failure: screenshot + the sign-in error text (when present) are attached to the report. */
export function captureOnFailure(getApp: () => AppSession | undefined): void {
  test.afterEach(async ({}, info) => {
    const app = getApp();
    if (!app || info.status === info.expectedStatus) return;
    const slug = info.title.replace(/[^a-z0-9]+/gi, "-").slice(0, 60).toLowerCase();
    await app.shot(`FAIL-${slug}`).catch(() => undefined);
    const err = await app.page
      .getByTestId("signin-error")
      .textContent({ timeout: 1500 })
      .catch(() => null);
    const body = await app.page.evaluate(() => document.body.innerText.slice(0, 1500)).catch(() => "");
    console.log(`FAIL "${info.title}" signin-error=${JSON.stringify(err)} page=${JSON.stringify(body)}`);
    if (err) await info.attach("signin-error", { body: err, contentType: "text/plain" });
  });
}
