// pdf.js reads `document.baseURI` while resolving asset URLs; a Web Worker has no document. Imported first by pdfWorker.ts.
const g = globalThis as unknown as { document?: unknown; location?: { href: string } };
if (!g.document) g.document = { baseURI: g.location?.href ?? "/" };
export {};
