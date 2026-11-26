import { beforeEach, describe, expect, it } from "vitest";
import { markLayoutSwitch, parkedDraftSaved, registerCreateForm, releaseCreateForm, resetLayoutSwitch, takeParkedDraft } from "./layoutSwitch";

describe("layoutSwitch", () => {
  beforeEach(resetLayoutSwitch);

  it("hands the open form's draft to the mount that follows a layout switch", () => {
    registerCreateForm("", "d1");
    markLayoutSwitch(1000);
    expect(takeParkedDraft("", 1050)).toBe("d1"); // the new form renders before the old one's cleanup
    expect(takeParkedDraft("", 1060)).toBeNull(); // single use
  });

  it("ignores a mount that is not part of a layout switch", () => {
    registerCreateForm("", "d1");
    expect(takeParkedDraft("", 5010)).toBeNull();
  });

  it("does not leak into a later, unrelated new-task screen", () => {
    registerCreateForm("", "d1");
    markLayoutSwitch(1000);
    expect(takeParkedDraft("", 9000)).toBeNull();
  });

  it("only matches the same new-task params", () => {
    registerCreateForm("?buildingId=b1", "d1");
    markLayoutSwitch(1000);
    expect(takeParkedDraft("?buildingId=b2", 1020)).toBeNull();
  });

  it("a submitted or discarded form is never adopted", () => {
    registerCreateForm("", "d1");
    releaseCreateForm("d1", null);
    markLayoutSwitch(1000);
    expect(takeParkedDraft("", 1010)).toBeNull();
  });

  it("exposes the unmounted form's pending save to the next mount", async () => {
    let done = false;
    const saved = new Promise<void>((r) => setTimeout(() => ((done = true), r()), 10));
    registerCreateForm("", "d1");
    markLayoutSwitch(1000);
    expect(takeParkedDraft("", 1002)).toBe("d1");
    releaseCreateForm("d1", saved);
    await parkedDraftSaved("d1");
    expect(done).toBe(true);
  });
});
