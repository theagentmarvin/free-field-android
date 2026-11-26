/** Lowercase hex sha256 via WebCrypto (secure context: Capacitor's https://localhost is one). */
export async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data as BufferSource);
  const bytes = new Uint8Array(digest);
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}
