/** Messages between the main thread and the tile worker (pdfWorker.ts). Binary payloads are transferred. */
export type ToWorker =
  | { t: "open"; id: number; length: number; bytes?: Uint8Array; quality: number; assetBase: string }
  | { t: "rangeData"; rid: number; data: Uint8Array }
  | { t: "rangeError"; rid: number; message: string }
  | { t: "region"; id: number; scale: number; px: number; py: number; w: number; h: number }
  | { t: "tile"; id: number; region: number; sx: number; sy: number; w: number; h: number }
  | { t: "release"; region: number }
  | { t: "cleanup" }
  | { t: "destroy"; id: number };

export type FromWorker =
  | { t: "ready" }
  | { t: "opened"; id: number; pageWidth: number; pageHeight: number; pageCount: number }
  | { t: "range"; rid: number; begin: number; end: number }
  | { t: "region"; id: number; region: number }
  | { t: "tile"; id: number; bytes: Uint8Array }
  | { t: "destroyed"; id: number }
  | { t: "error"; id: number; message: string };
