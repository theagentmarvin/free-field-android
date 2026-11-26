import { describe, expect, it, vi } from "vitest";
import type { Auth, User } from "firebase/auth";
import { ANDROID_PACKAGE } from "./config";
import {
  actionCodeSettings,
  completeSignInFromLink,
  inviteIdFromLink,
  isPlausibleEmail,
  normalizeEmail,
  requestSignInLink,
  type EmailLinkApi,
  type KeyValueStore,
} from "./emailLink";
import { EMAIL_STORAGE_KEY } from "./config";

const auth = {} as Auth;
const user = { uid: "u1", email: "a@b.co" } as User;

function memStore(init: Record<string, string> = {}): KeyValueStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(init));
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

function fakeApi(over: Partial<EmailLinkApi> = {}): EmailLinkApi {
  return {
    isLink: vi.fn(() => true),
    send: vi.fn(async () => undefined),
    signIn: vi.fn(async () => ({ user })),
    ...over,
  };
}

describe("email helpers", () => {
  it("validates and normalizes", () => {
    expect(isPlausibleEmail("a@b.co")).toBe(true);
    expect(isPlausibleEmail("nope")).toBe(false);
    expect(isPlausibleEmail("a b@c.de")).toBe(false);
    expect(normalizeEmail("  A@B.Co ")).toBe("a@b.co");
  });
  it("builds app-handled action code settings for the android package", () => {
    const s = actionCodeSettings("https://x.test/finish-sign-in");
    expect(s.handleCodeInApp).toBe(true);
    expect(s.android).toEqual({ packageName: ANDROID_PACKAGE, installApp: false });
    expect(s.url).toBe("https://x.test/finish-sign-in");
  });
});

describe("requestSignInLink", () => {
  it("sends the link and remembers the normalized address", async () => {
    const store = memStore();
    const api = fakeApi();
    const email = await requestSignInLink(auth, " Me@Site.Org ", store, api, actionCodeSettings("https://x.test/f"));
    expect(email).toBe("me@site.org");
    expect(api.send).toHaveBeenCalledWith(auth, "me@site.org", expect.objectContaining({ url: "https://x.test/f" }));
    expect(store.getItem(EMAIL_STORAGE_KEY)).toBe("me@site.org");
  });
  it("rejects an invalid address without calling Firebase", async () => {
    const api = fakeApi();
    await expect(requestSignInLink(auth, "bad", memStore(), api)).rejects.toThrow(/valid email/);
    expect(api.send).not.toHaveBeenCalled();
  });
  it("does not remember the email when sending fails", async () => {
    const store = memStore();
    const api = fakeApi({ send: vi.fn(async () => Promise.reject(new Error("network"))) });
    await expect(requestSignInLink(auth, "a@b.co", store, api)).rejects.toThrow("network");
    expect(store.getItem(EMAIL_STORAGE_KEY)).toBeNull();
  });
});

describe("completeSignInFromLink", () => {
  const link = "https://x.test/finish-sign-in?mode=signIn&oobCode=abc&apiKey=k";

  it("ignores URLs that are not sign-in links", async () => {
    const api = fakeApi({ isLink: vi.fn(() => false) });
    expect(await completeSignInFromLink(auth, "https://x.test/other", memStore(), undefined, api)).toEqual({ status: "ignored" });
    expect(api.signIn).not.toHaveBeenCalled();
  });
  it("asks for the email when none is stored", async () => {
    const api = fakeApi();
    expect(await completeSignInFromLink(auth, link, memStore(), undefined, api)).toEqual({ status: "needs-email" });
    expect(api.signIn).not.toHaveBeenCalled();
  });
  it("signs in with the stored email and clears it", async () => {
    const store = memStore({ [EMAIL_STORAGE_KEY]: "a@b.co" });
    const api = fakeApi();
    const res = await completeSignInFromLink(auth, link, store, undefined, api);
    expect(res).toEqual({ status: "signed-in", user, inviteId: null });
    expect(api.signIn).toHaveBeenCalledWith(auth, "a@b.co", link);
    expect(store.getItem(EMAIL_STORAGE_KEY)).toBeNull();
  });
  it("uses the typed email override", async () => {
    const api = fakeApi();
    await completeSignInFromLink(auth, link, memStore(), " Typed@X.org ", api);
    expect(api.signIn).toHaveBeenCalledWith(auth, "typed@x.org", link);
  });
  it("keeps the stored email and reports the error when sign-in fails", async () => {
    const store = memStore({ [EMAIL_STORAGE_KEY]: "a@b.co" });
    const api = fakeApi({ signIn: vi.fn(async () => Promise.reject(new Error("auth/invalid-action-code"))) });
    const res = await completeSignInFromLink(auth, link, store, undefined, api);
    expect(res).toEqual({ status: "error", message: "auth/invalid-action-code" });
    expect(store.getItem(EMAIL_STORAGE_KEY)).toBe("a@b.co");
  });
});

describe("inviteIdFromLink", () => {
  it("reads inviteId directly or from the nested continue URL", () => {
    expect(inviteIdFromLink("https://x.test/f?inviteId=i1&oobCode=a")).toBe("i1");
    const nested = `https://p.test/__/auth/action?continueUrl=${encodeURIComponent("https://x.test/f?inviteId=i2")}`;
    expect(inviteIdFromLink(nested)).toBe("i2");
    expect(inviteIdFromLink("https://x.test/f?oobCode=a")).toBeNull();
    expect(inviteIdFromLink("not a url")).toBeNull();
  });
});
