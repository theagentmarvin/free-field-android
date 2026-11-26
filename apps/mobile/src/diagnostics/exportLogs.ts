import type { RingLogger } from "./logger";

export interface LogExportDeps {
  /** Write text to a file the user can reach; resolves to its URI. */
  writeFile(name: string, text: string): Promise<string>;
  /** Hand the file to the system share sheet; false when sharing is unavailable. */
  share(uri: string, title: string): Promise<boolean>;
  now(): number;
}

export interface LogExportResult {
  name: string;
  uri: string;
  shared: boolean;
  lines: number;
}

export function logFileName(now: number): string {
  return `ffm-logs-${new Date(now).toISOString().replace(/[:.]/g, "-")}.txt`;
}

/** The native share promise only settles when the user closes the sheet; don't wait for that. */
export const SHARE_SHEET_GRACE_MS = 2000;

export async function exportLogs(
  logger: RingLogger,
  deps: LogExportDeps,
  header: string[] = [],
  graceMs: number = SHARE_SHEET_GRACE_MS,
): Promise<LogExportResult> {
  const name = logFileName(deps.now());
  const entries = logger.entries();
  const text = [...header, `entries: ${entries.length}`, "", logger.format()].join("\n") + "\n";
  const uri = await deps.writeFile(name, text);
  let shared = false;
  try {
    const opened = deps.share(uri, "FreeField Field logs");
    // Rejection (e.g. dismissed) after the grace period is ignored; the file is already written.
    opened.catch(() => undefined);
    // Still pending after the grace period means the sheet is on screen: count it as shared.
    shared = await Promise.race([opened, new Promise<boolean>((r) => setTimeout(() => r(true), graceMs))]);
  } catch {
    /* user dismissed the sheet or sharing is unavailable: the file is still written */
  }
  return { name, uri, shared, lines: entries.length };
}
