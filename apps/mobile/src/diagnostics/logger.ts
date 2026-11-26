/** In-memory ring buffer of app log lines (no PII: callers log events, not user data). */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  t: number;
  level: LogLevel;
  msg: string;
}

export const DEFAULT_LOG_CAPACITY = 500;
const MAX_LINE = 2000;

export class RingLogger {
  private buf: LogEntry[] = [];
  constructor(
    private readonly capacity = DEFAULT_LOG_CAPACITY,
    private readonly now: () => number = Date.now,
  ) {
    if (capacity < 1) throw new Error("capacity must be >= 1");
  }

  log(level: LogLevel, ...args: unknown[]): void {
    const msg = args.map(stringify).join(" ").slice(0, MAX_LINE);
    this.buf.push({ t: this.now(), level, msg });
    if (this.buf.length > this.capacity) this.buf.splice(0, this.buf.length - this.capacity);
  }

  debug = (...a: unknown[]) => this.log("debug", ...a);
  info = (...a: unknown[]) => this.log("info", ...a);
  warn = (...a: unknown[]) => this.log("warn", ...a);
  error = (...a: unknown[]) => this.log("error", ...a);

  entries(): LogEntry[] {
    return [...this.buf];
  }

  clear(): void {
    this.buf = [];
  }

  /** One line per entry: ISO time, level, message. */
  format(): string {
    return this.buf.map((e) => `${new Date(e.t).toISOString()} ${e.level.toUpperCase().padEnd(5)} ${e.msg}`).join("\n");
  }
}

function stringify(v: unknown): string {
  if (typeof v === "string") return v;
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

export const appLog = new RingLogger();

interface ConsoleLike {
  log: (...a: unknown[]) => void;
  info: (...a: unknown[]) => void;
  warn: (...a: unknown[]) => void;
  error: (...a: unknown[]) => void;
}
interface WindowLike {
  addEventListener(type: string, cb: (e: Event) => void): void;
}

/** Mirror console output and uncaught errors into the ring buffer. Returns an uninstall function. */
export function installConsoleCapture(logger: RingLogger, c: ConsoleLike = console, w?: WindowLike): () => void {
  const orig = { log: c.log, info: c.info, warn: c.warn, error: c.error };
  const wrap = (level: LogLevel, fn: (...a: unknown[]) => void) =>
    (...args: unknown[]) => {
      logger.log(level, ...args);
      fn.apply(c, args);
    };
  c.log = wrap("info", orig.log);
  c.info = wrap("info", orig.info);
  c.warn = wrap("warn", orig.warn);
  c.error = wrap("error", orig.error);
  w?.addEventListener("error", (e) => logger.error("uncaught", (e as ErrorEvent).message ?? ""));
  w?.addEventListener("unhandledrejection", (e) => logger.error("unhandled rejection", (e as PromiseRejectionEvent).reason));
  return () => Object.assign(c, orig);
}
