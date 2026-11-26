import type { PdfInput } from "./pdfInput";

/** pdf.js getDocument options shared by the main-thread and the worker backends. */
export interface DocOptions {
  assetBase: string;
}

export function baseDocParams(assetBase: string) {
  return {
    cMapUrl: `${assetBase}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${assetBase}standard_fonts/`,
    wasmUrl: `${assetBase}wasm/`,
    enableXfa: false,
    // Huge embedded images are down-sampled by pdf.js instead of decoded at full size.
    maxImageSize: 16 * 1024 * 1024,
  };
}

export const inputLength = (i: PdfInput): number => (i.kind === "bytes" ? i.bytes.length : i.length);
