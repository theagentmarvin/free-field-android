import { describe, expect, it } from "vitest";
import { ANDROID_PACKAGE, authLinkDomain, continueUrl, emulatorHost, usesEmulator } from "./config";

describe("auth config", () => {
  it("has no built-in default host: with nothing configured it throws", () => {
    expect(() => authLinkDomain({}, "")).toThrow(/authLinkDomain/);
    expect(() => authLinkDomain({ VITE_FF_AUTH_LINK_DOMAIN: "  " }, "")).toThrow();
    expect(() => continueUrl({}, "")).toThrow();
  });
  it("takes the domain from company.config.json", () => {
    expect(authLinkDomain({}, "freefield.mycompany.com")).toBe("freefield.mycompany.com");
    expect(continueUrl({}, "https://freefield.mycompany.com/")).toBe("https://freefield.mycompany.com/finish-sign-in");
  });
  it("lets VITE_FF_AUTH_LINK_DOMAIN override the config and strips scheme and slashes", () => {
    expect(authLinkDomain({ VITE_FF_AUTH_LINK_DOMAIN: "https://field.example.com/" }, "other.test")).toBe("field.example.com");
    expect(continueUrl({ VITE_FF_AUTH_LINK_DOMAIN: "field.example.com" }, "other.test")).toBe("https://field.example.com/finish-sign-in");
  });
  it("bakes the application id in from the company config", () => {
    expect(ANDROID_PACKAGE).toMatch(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
  });
  it("reads the emulator flags", () => {
    expect(usesEmulator({})).toBe(false);
    expect(usesEmulator({ VITE_FIREBASE_USE_EMULATOR: "true" })).toBe(true);
    expect(emulatorHost({})).toBe("localhost");
    expect(emulatorHost({ VITE_FIREBASE_EMULATOR_HOST: "10.0.2.2" })).toBe("10.0.2.2");
  });
});
