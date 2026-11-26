import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import type { LogExportDeps } from "./exportLogs";

/** Capacitor-backed export deps: file in the app cache dir + system share sheet. */
export const nativeLogExportDeps: LogExportDeps = {
  now: Date.now,
  async writeFile(name, text) {
    const res = await Filesystem.writeFile({ path: `logs/${name}`, data: text, directory: Directory.Cache, encoding: Encoding.UTF8, recursive: true });
    return res.uri;
  },
  async share(uri, title) {
    const { value } = await Share.canShare();
    if (!value) return false;
    await Share.share({ title, files: [uri] });
    return true;
  },
};
