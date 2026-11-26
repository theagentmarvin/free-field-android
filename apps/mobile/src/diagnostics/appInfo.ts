import { App } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";

declare const __APP_VERSION__: string;

export interface AppInfo {
  version: string;
  build: string | null;
  platform: string;
}

export async function getAppInfo(): Promise<AppInfo> {
  const fallback = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";
  if (!Capacitor.isNativePlatform()) return { version: fallback, build: null, platform: Capacitor.getPlatform() };
  try {
    const info = await App.getInfo();
    return { version: info.version, build: info.build, platform: Capacitor.getPlatform() };
  } catch {
    return { version: fallback, build: null, platform: Capacitor.getPlatform() };
  }
}
