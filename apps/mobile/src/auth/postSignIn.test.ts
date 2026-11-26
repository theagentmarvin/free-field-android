import { describe, expect, it, vi } from "vitest";
import type { User } from "firebase/auth";
import { runPostSignIn, type PostSignInDeps } from "./postSignIn";

const user = { uid: "u1", email: "a@b.co" } as User;

function deps(over: Partial<PostSignInDeps> = {}): PostSignInDeps {
  return {
    profileExists: vi.fn(async () => false),
    writeProfile: vi.fn(async () => undefined),
    redeemInvitation: vi.fn(async () => undefined),
    refreshClaims: vi.fn(async () => ({})),
    ...over,
  };
}

describe("runPostSignIn", () => {
  it("creates the profile with createdAt when missing, then refreshes claims", async () => {
    const d = deps();
    const r = await runPostSignIn(user, null, d);
    expect(r).toEqual({ profileWritten: true, redeemError: null });
    const [, data] = (d.writeProfile as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(data).toMatchObject({ uid: "u1", email: "a@b.co" });
    expect(typeof data.createdAt).toBe("number");
    expect(d.redeemInvitation).not.toHaveBeenCalled();
    expect(d.refreshClaims).toHaveBeenCalledTimes(1);
  });
  it("does not overwrite createdAt for an existing profile", async () => {
    const d = deps({ profileExists: vi.fn(async () => true) });
    await runPostSignIn(user, null, d);
    expect((d.writeProfile as ReturnType<typeof vi.fn>).mock.calls[0][1]).toEqual({ uid: "u1", email: "a@b.co" });
  });
  it("redeems an invitation and reports its failure without throwing", async () => {
    const d = deps({ redeemInvitation: vi.fn(async () => Promise.reject(new Error("expired"))) });
    const r = await runPostSignIn(user, "inv1", d);
    expect(d.redeemInvitation).toHaveBeenCalledWith("inv1");
    expect(r.redeemError).toBe("expired");
    expect(d.refreshClaims).toHaveBeenCalled();
  });
  it("survives offline failures of every step", async () => {
    const boom = vi.fn(async () => Promise.reject(new Error("offline")));
    const d = deps({ profileExists: boom, refreshClaims: boom });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(runPostSignIn(user, null, d)).resolves.toEqual({ profileWritten: false, redeemError: null });
    warn.mockRestore();
  });
});
