import http from "node:http";
import { Transform } from "node:stream";

/**
 * Tiny HTTP proxy in front of the Storage emulator that rate-limits `alt=media` downloads, so a test can
 * kill the app while a download is genuinely in flight. Range requests pass through untouched.
 */
export interface ThrottleProxy {
  close(): Promise<void>;
  setRate(bps: number): void;
  /** Rate-limit request bodies of uploads (bytes/s, 0 = off). */
  setUploadRate(bps: number): void;
  /** Cut the connection once, after this many upload body bytes of the next upload requests (0 = off). */
  dropUploadAfter(bytes: number): void;
  /** Upload request bodies seen (bytes) and the number of connections cut. */
  stats(): { uploadBytes: number; drops: number };
  ranges: string[];
}

export function startThrottleProxy(opts: { listen: number; target: number; bytesPerSec: number }): Promise<ThrottleProxy> {
  let rate = opts.bytesPerSec;
  let upRate = 0;
  let dropAfter = 0;
  let uploadBytes = 0;
  let drops = 0;
  const isUpload = (req: http.IncomingMessage) => (req.method === "POST" || req.method === "PUT") && Number(req.headers["content-length"] ?? 0) > 4096;
  const ranges: string[] = []; // Range header of every download request, in order ("" when absent)
  const server = http.createServer((req, res) => {
    if ((req.url ?? "").includes("alt=media")) ranges.push(String(req.headers.range ?? ""));
    const up = http.request({ host: "127.0.0.1", port: opts.target, path: req.url, method: req.method, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      if (!(req.url ?? "").includes("alt=media") || rate <= 0) return void r.pipe(res);
      const slice = 64 * 1024;
      const gate = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          let i = 0;
          const next = () => {
            if (i >= chunk.length) return cb();
            this.push(chunk.subarray(i, i + slice));
            const sent = Math.min(slice, chunk.length - i);
            i += slice;
            setTimeout(next, (sent / rate) * 1000);
          };
          next();
        },
      });
      r.pipe(gate).pipe(res);
    });
    up.on("error", () => res.destroy());
    req.on("aborted", () => up.destroy());
    res.on("close", () => up.destroy());
    if (isUpload(req) && (upRate > 0 || dropAfter > 0)) {
      let seen = 0;
      const gate = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          seen += chunk.length;
          uploadBytes += chunk.length;
          if (dropAfter > 0 && seen >= dropAfter) {
            dropAfter = 0;
            drops += 1;
            req.destroy();
            up.destroy();
            res.destroy();
            return cb();
          }
          this.push(chunk);
          if (upRate > 0) setTimeout(cb, (chunk.length / upRate) * 1000);
          else cb();
        },
      });
      req.pipe(gate).pipe(up);
    } else req.pipe(up);
  });
  return new Promise((resolve) =>
    server.listen(opts.listen, "127.0.0.1", () =>
      resolve({
        setRate: (bps) => void (rate = bps),
        setUploadRate: (bps) => void (upRate = bps),
        dropUploadAfter: (bytes) => void (dropAfter = bytes),
        stats: () => ({ uploadBytes, drops }),
        ranges,
        close: () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))),
      }),
    ),
  );
}
