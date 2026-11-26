import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";

/** Native streaming primitives (android/app/src/main/java/app/freefield/field/FfmFilesPlugin.java). */
export interface FfmFilesPlugin {
  download(o: { id: string; url: string; path: string; offset: number; headers?: Record<string, string> }): Promise<{ bytes: number; total: number }>;
  cancel(o: { id: string }): Promise<void>;
  hashFile(o: { path: string }): Promise<{ sha256: string; size: number }>;
  freeSpace(): Promise<{ free: number; total: number }>;
  keepAwake(o: { on: boolean }): Promise<void>;
  /** Open this app's Android settings page. */
  openAppSettings(): Promise<void>;
  /** Read `length` bytes at `offset` (base64 over the bridge). Resolves fewer bytes at the end of the file. */
  readRange(o: { path: string; offset: number; length: number }): Promise<{ data: string }>;
  /** Copy a file from the app cache dir (`path` is relative to it) into the public Downloads folder (MediaStore, API 29+). */
  saveToDownloads(o: { path: string; name: string; mime: string }): Promise<{ name: string; where: string }>;
  /** Did the previous WebView renderer die (memory kill or crash)? Clears the native flag. */
  takeRendererGone(): Promise<{ gone: boolean; crashed: boolean; recent: number }>;
  /** Android onTrimMemory level (ComponentCallbacks2). */
  addListener(event: "trimMemory", cb: (e: { level: number }) => void): Promise<PluginListenerHandle>;
  addListener(event: "progress", cb: (e: { id: string; bytes: number; total: number }) => void): Promise<PluginListenerHandle>;
}

export const FfmFiles = registerPlugin<FfmFilesPlugin>("FfmFiles");
