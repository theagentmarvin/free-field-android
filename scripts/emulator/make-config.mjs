// Derive the Firebase emulator config from the vendored monorepo firebase.json:
// keep its rules/indexes (absolute paths), run only auth+firestore+storage on 127.0.0.1, no UI.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const [src, dest] = process.argv.slice(2);
if (!src || !dest) throw new Error("usage: make-config.mjs <vendor firebase.json> <out>");
const base = dirname(resolve(src));
const cfg = JSON.parse(readFileSync(src, "utf8"));
const off = Number(process.env.FFM_EMU_PORT_OFFSET ?? 0);
const abs = (p) => resolve(base, p);

const out = {
  firestore: { rules: abs(cfg.firestore.rules), indexes: abs(cfg.firestore.indexes) },
  storage: { rules: abs(cfg.storage.rules) },
  emulators: {
    auth: { host: "127.0.0.1", port: cfg.emulators.auth.port + off },
    firestore: { host: "127.0.0.1", port: cfg.emulators.firestore.port + off },
    storage: { host: "127.0.0.1", port: cfg.emulators.storage.port + off },
    ui: { enabled: false },
    singleProjectMode: true,
  },
};
writeFileSync(dest, JSON.stringify(out, null, 2));
console.log(`wrote ${dest}`);
