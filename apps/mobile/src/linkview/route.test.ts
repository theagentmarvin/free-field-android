import { describe, expect, it } from "vitest";
import { linkviewPath, parseLinkview } from "./route";
import { newTaskExit, linkviewBack } from "../tasks/origin";
import { newTaskUrl } from "../plans/anchor";

describe("linkview route", () => {
  it("builds and parses the path", () => {
    const p = linkviewPath("b-1", { plan: "pdf_1", storey: "101 FIRST FLOOR", start: { x: 1.23456, z: -4, bearingDeg: 90 } });
    expect(p.startsWith("/linkview/b-1?")).toBe(true);
    const parsed = parseLinkview(p.slice(p.indexOf("?")));
    expect(parsed).toEqual({ plan: "pdf_1", storey: "101 FIRST FLOOR", start: { x: 1.235, z: -4, bearingDeg: 90 } });
  });
  it("a bare path has no parameters; bad ones are dropped", () => {
    expect(linkviewPath("b1")).toBe("/linkview/b1");
    expect(parseLinkview("")).toEqual({ plan: null, storey: null, start: null });
    expect(parseLinkview("plan=../x&x=abc&z=1")).toEqual({ plan: null, storey: null, start: null });
    expect(parseLinkview("x=1&z=2").start).toEqual({ x: 1, z: 2, bearingDeg: null });
  });
  it("encodes the building id", () => {
    expect(linkviewPath("a b")).toBe("/linkview/a%20b");
  });
});

describe("new task from the Link view returns to it", () => {
  const back = linkviewPath("b1", { plan: "pdf-1", storey: "L1", start: { x: 1, z: 2, bearingDeg: 45 } });
  const url = `${newTaskUrl({ pdfFileId: "pdf-1", planVersionId: "v1", page: 1, uv: [0.2, 0.3] })}&back=${encodeURIComponent(back)}`;
  const search = url.slice(url.indexOf("?"));
  it("cancel and save go back to the Link view at the same place", () => {
    const x = newTaskExit(search);
    expect(x.cancelTo).toBe(back);
    expect(x.saveTo("t1")).toBe(back);
  });
  it("only in-app Link view paths are accepted", () => {
    expect(linkviewBack("back=https%3A%2F%2Fevil.example%2Fx")).toBeNull();
    expect(linkviewBack("back=%2Ftasks%2Fnew")).toBeNull();
    expect(linkviewBack("back=%2Flinkview%2Fb1%2F..%2Fx")).toBeNull();
    expect(newTaskExit(`anchor=plan~pdf-1~v1~1~0.2~0.3&back=%2Flinkview%2Fb1`).cancelTo).toBe("/linkview/b1");
  });
  it("without back the plan is still the origin", () => {
    expect(newTaskExit(search.replace(/&back=.*/, "")).cancelTo).toBe("/plans/pdf-1");
  });
});
