import { linkDomain } from "../company";
/**
 * Minimal REST client for the Firebase emulators (no Admin SDK dependency).
 * "Bearer owner" is the emulators' admin credential: it bypasses security rules,
 * exactly like the Admin SDK does.
 */
export const PROJECT = "demo-freefield";
const HOST = process.env.FFM_EMU_HOST ?? "127.0.0.1";
// Host-side ports = the standard ports + FFM_EMU_PORT_OFFSET (the device still sees 9099/8080 via adb reverse).
const OFF = Number(process.env.FFM_EMU_PORT_OFFSET ?? 0);
export const AUTH_URL = `http://${HOST}:${9099 + OFF}`;
export const FS_URL = `http://${HOST}:${8080 + OFF}`;
const DOCS = `${FS_URL}/v1/projects/${PROJECT}/databases/(default)/documents`;
const OWNER = { Authorization: "Bearer owner", "Content-Type": "application/json" };

type FsValue = Record<string, unknown>;

export class Timestamp {
  constructor(public readonly iso: string) {}
}

export function toFsValue(v: unknown): FsValue {
  if (v === null || v === undefined) return { nullValue: null };
  if (v instanceof Timestamp) return { timestampValue: v.iso };
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFsValue) } };
  if (typeof v === "object") return { mapValue: { fields: toFsFields(v as Record<string, unknown>) } };
  throw new Error(`unsupported value ${String(v)}`);
}

export function toFsFields(o: Record<string, unknown>): Record<string, FsValue> {
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, toFsValue(v)]));
}

export function fromFsValue(v: FsValue): unknown {
  if ("nullValue" in v) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("timestampValue" in v) return v.timestampValue;
  if ("arrayValue" in v) return ((v.arrayValue as { values?: FsValue[] }).values ?? []).map(fromFsValue);
  if ("mapValue" in v) return fromFsFields((v.mapValue as { fields?: Record<string, FsValue> }).fields ?? {});
  return undefined;
}

export function fromFsFields(f: Record<string, FsValue>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(f).map(([k, v]) => [k, fromFsValue(v)]));
}

async function must(res: Response, what: string): Promise<Response> {
  if (!res.ok) throw new Error(`${what}: HTTP ${res.status} ${await res.text()}`);
  return res;
}

export async function setDoc(path: string, data: Record<string, unknown>): Promise<void> {
  await must(await fetch(`${DOCS}/${path}`, { method: "PATCH", headers: OWNER, body: JSON.stringify({ fields: toFsFields(data) }) }), `set ${path}`);
}

export async function listDocs(collectionPath: string): Promise<Array<{ id: string; data: Record<string, unknown> }>> {
  const res = await fetch(`${DOCS}/${collectionPath}?pageSize=300`, { headers: OWNER });
  if (res.status === 404) return [];
  await must(res, `list ${collectionPath}`);
  const body = (await res.json()) as { documents?: Array<{ name: string; fields?: Record<string, FsValue> }> };
  return (body.documents ?? []).map((d) => ({ id: d.name.split("/").pop()!, data: fromFsFields(d.fields ?? {}) }));
}

export async function clearFirestore(): Promise<void> {
  await must(await fetch(`${FS_URL}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" }), "clear firestore");
}

export async function clearAuth(): Promise<void> {
  await must(await fetch(`${AUTH_URL}/emulator/v1/projects/${PROJECT}/accounts`, { method: "DELETE" }), "clear auth");
}

/** Admin-create an email user with a fixed uid (so member docs can reference it). */
export async function createAuthUser(uid: string, email: string): Promise<void> {
  await must(
    await fetch(`${AUTH_URL}/identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts`, {
      method: "POST",
      headers: OWNER,
      body: JSON.stringify({ localId: uid, email, emailVerified: true }),
    }),
    `create user ${email}`,
  );
}

export interface OobCode {
  email: string;
  requestType: string;
  oobCode: string;
  oobLink: string;
}

export async function listOobCodes(): Promise<OobCode[]> {
  const res = await must(await fetch(`${AUTH_URL}/emulator/v1/projects/${PROJECT}/oobCodes`), "list oobCodes");
  return ((await res.json()) as { oobCodes: OobCode[] }).oobCodes ?? [];
}

/** Newest e-mail sign-in code sent to `email`, polling until it shows up. */
export async function waitForSignInCode(email: string, timeoutMs = 30_000): Promise<OobCode> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = (await listOobCodes()).filter((c) => c.email === email && c.requestType === "EMAIL_SIGNIN").pop();
    if (hit) return hit;
    if (Date.now() > deadline) throw new Error(`no sign-in link for ${email} within ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

/**
 * The link a user would open from the e-mail, rewritten to the App Link host so
 * Android routes it to the app. The oobCode and apiKey are the emulator's own.
 */
export { linkDomain };

export function appLinkFor(code: OobCode, domain = linkDomain()): string {
  const u = new URL(code.oobLink);
  const q = new URLSearchParams({ mode: "signIn", lang: "en", oobCode: code.oobCode, apiKey: u.searchParams.get("apiKey") ?? "fake-api-key" });
  return `https://${domain}/finish-sign-in?${q.toString()}`;
}

// ── seed data ────────────────────────────────────────────────────────────────
export const SEED = {
  userMulti: { uid: "e2e-user-multi", email: "multi@freefield.test" },
  userSingle: { uid: "e2e-user-single", email: "single@freefield.test" },
  projects: [
    { id: "e2e-alpha", name: "Site Alpha" },
    { id: "e2e-beta", name: "Site Beta" },
    { id: "e2e-gamma", name: "Site Gamma" },
  ],
} as const;

export async function seed(): Promise<void> {
  await clearFirestore();
  await clearAuth();
  for (const u of [SEED.userMulti, SEED.userSingle]) await createAuthUser(u.uid, u.email);
  const now = new Timestamp(new Date().toISOString());
  for (const p of SEED.projects) {
    await setDoc(`projects/${p.id}`, { name: p.name, ownerUid: "e2e-admin", createdAt: Date.now() });
    // next = 0 so the first client create allocates num 1 inside the rules-pinned transaction.
    await setDoc(`projects/${p.id}/taskCounters/tasks`, { next: 0 });
  }
  const member = (uid: string, projectId: string, role = "member") =>
    setDoc(`projects/${projectId}/members/${uid}`, { uid, role, status: "active", joinedAt: now, invitedBy: "e2e-seed" });
  await member(SEED.userMulti.uid, "e2e-alpha");
  await member(SEED.userMulti.uid, "e2e-beta");
  await member(SEED.userSingle.uid, "e2e-gamma");
  for (const u of [SEED.userMulti, SEED.userSingle]) {
    await setDoc(`users/${u.uid}`, { uid: u.uid, email: u.email, displayName: u.email.split("@")[0], createdAt: Date.now() });
  }
}

// ── Storage emulator (REST) ──────────────────────────────────────────────────
export const BUCKET = `${PROJECT}.appspot.com`;
export const ST_URL = `http://${HOST}:${9199 + OFF}`;

/** Upload an object as the emulator's admin (bypasses rules). The emulator hands out a download token. */
export async function uploadObject(path: string, body: Uint8Array, contentType = "application/octet-stream"): Promise<void> {
  const res = await fetch(`${ST_URL}/upload/storage/v1/b/${BUCKET}/o?uploadType=media&name=${encodeURIComponent(path)}`, {
    method: "POST",
    headers: { Authorization: "Bearer owner", "Content-Type": contentType },
    body: body as unknown as BodyInit,
  });
  await must(res, `upload ${path}`);
}

// ── QA helpers ───────────────────────────────────────────────────────────────

export async function deleteDoc(path: string): Promise<void> {
  await must(await fetch(`${DOCS}/${path}`, { method: "DELETE", headers: OWNER }), `delete ${path}`);
}

/** Writes many documents with the REST `commit` endpoint (500 per request). */
export async function batchSet(docs: Array<{ path: string; data: Record<string, unknown> }>): Promise<void> {
  const root = `projects/${PROJECT}/databases/(default)/documents`;
  for (let i = 0; i < docs.length; i += 400) {
    const writes = docs.slice(i, i + 400).map((d) => ({ update: { name: `${root}/${d.path}`, fields: toFsFields(d.data) } }));
    await must(
      await fetch(`${FS_URL}/v1/projects/${PROJECT}/databases/(default)/documents:commit`, { method: "POST", headers: OWNER, body: JSON.stringify({ writes }) }),
      `commit ${i}`,
    );
  }
}

/** All documents of a collection (pages through `nextPageToken`). */
export async function listAllDocs(collectionPath: string): Promise<Array<{ id: string; data: Record<string, unknown> }>> {
  const out: Array<{ id: string; data: Record<string, unknown> }> = [];
  let token = "";
  for (;;) {
    const res = await fetch(`${DOCS}/${collectionPath}?pageSize=300${token ? `&pageToken=${encodeURIComponent(token)}` : ""}`, { headers: OWNER });
    if (res.status === 404) return out;
    await must(res, `list ${collectionPath}`);
    const body = (await res.json()) as { documents?: Array<{ name: string; fields?: Record<string, FsValue> }>; nextPageToken?: string };
    for (const d of body.documents ?? []) out.push({ id: d.name.split("/").pop()!, data: fromFsFields(d.fields ?? {}) });
    if (!body.nextPageToken) return out;
    token = body.nextPageToken;
  }
}

/** Object names under a Storage prefix (emulator REST). */
export async function listObjects(prefix: string): Promise<string[]> {
  const res = await fetch(`${ST_URL}/storage/v1/b/${BUCKET}/o?prefix=${encodeURIComponent(prefix)}`, { headers: { Authorization: "Bearer owner" } });
  await must(res, `list objects ${prefix}`);
  return (((await res.json()) as { items?: Array<{ name: string }> }).items ?? []).map((i) => i.name);
}
