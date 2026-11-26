import type { OfflineSettings } from "./types";

// "ffm" prefix: wiped with the other local keys on sign-out.
const WIFI = "ffm-offline-wifi-only";
const AUTO = "ffm-offline-auto-update";

type KV = Pick<Storage, "getItem" | "setItem">;
const ls = (): KV | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

export function readSettings(kv: KV | null = ls()): OfflineSettings {
  const get = (k: string, d: boolean) => {
    try {
      const v = kv?.getItem(k);
      return v == null ? d : v === "1";
    } catch {
      return d;
    }
  };
  return { wifiOnly: get(WIFI, true), autoUpdate: get(AUTO, true) };
}

export function writeSettings(patch: Partial<OfflineSettings>, kv: KV | null = ls()): OfflineSettings {
  const next = { ...readSettings(kv), ...patch };
  try {
    kv?.setItem(WIFI, next.wifiOnly ? "1" : "0");
    kv?.setItem(AUTO, next.autoUpdate ? "1" : "0");
  } catch {
    /* storage blocked: setting lasts for this run only */
  }
  return next;
}
