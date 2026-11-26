import { describe, expect, it } from "vitest";
import { uvToWorld, type CalibrationLike } from "@ff/tasks-react";
import { AUTO_FINISH_POINTS, angleDeg, formatAngle, formatMeasurement, measurementValue, parseLength, uvDistanceMetres, uvToPage } from "./planMath";
import { distance, pickCalibrationScale, polygonArea, polylineLength, resolvePageScale, scaleFromTwoPoints, UNCALIBRATED } from "./webMath";

const calibrated = { source: "calibrated", metresPerUnit: 0.034 } as const;

describe("lengths and areas (page units, the web's math)", () => {
  it("polyline length sums the segments", () => {
    expect(polylineLength([{ x: 0, y: 0 }, { x: 3, y: 4 }, { x: 3, y: 10 }])).toBeCloseTo(11, 9);
    expect(measurementValue({ kind: "length", points: [{ x: 0, y: 0 }, { x: 3, y: 4 }] })).toBe(5);
  });
  it("polygon area is the shoelace magnitude whatever the winding", () => {
    const sq = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
    expect(polygonArea(sq)).toBe(100);
    expect(polygonArea([...sq].reverse())).toBe(100);
    expect(polygonArea([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 0, y: 3 }])).toBe(6);
    expect(polygonArea(sq.slice(0, 2))).toBe(0);
  });
});

describe("angle", () => {
  it("is the interior angle at the middle point", () => {
    expect(angleDeg({ x: 1, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 1 })).toBeCloseTo(90, 9);
    expect(angleDeg({ x: 1, y: 0 }, { x: 0, y: 0 }, { x: -1, y: 0 })).toBeCloseTo(180, 9);
    expect(angleDeg({ x: 1, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 1 })).toBeCloseTo(45, 9);
    expect(angleDeg({ x: 5, y: 5 }, { x: 5, y: 5 }, { x: 1, y: 1 })).toBe(0);
  });
  it("is order independent and independent of the page y direction", () => {
    const a = { x: 3, y: 1 };
    const v = { x: 0, y: 0 };
    const b = { x: 1, y: 3 };
    expect(angleDeg(a, v, b)).toBeCloseTo(angleDeg(b, v, a), 9);
    expect(angleDeg({ x: 3, y: -1 }, v, { x: 1, y: -3 })).toBeCloseTo(angleDeg(a, v, b), 9);
  });
  it("formats to one decimal and finishes on the third point", () => {
    expect(formatAngle(37.456)).toBe("37.5°");
    expect(AUTO_FINISH_POINTS.angle).toBe(3);
    expect(formatMeasurement({ kind: "angle", points: [{ x: 1, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 1 }] }, UNCALIBRATED)).toBe("90.0°");
  });
});

describe("uv to metres through the calibration", () => {
  const page = { width: 2384, height: 1684 };
  // the demo S-101 calibration row
  const calib: CalibrationLike = {
    id: "c",
    storeyName: "101",
    transformParams: { scale: 0.033983052125696425, rotation: 0.00395249126410087, translateX: -10.922044471609226, translateZ: -13.816282128605584 },
    updatedAt: 1,
  };
  it("pickCalibrationScale feeds metres per page unit", () => {
    const mpu = pickCalibrationScale([{ projectId: "p", updatedAt: 1, transformParams: calib.transformParams }], "p");
    expect(mpu).toBeCloseTo(0.033983, 5);
    expect(resolvePageScale({ page: 1, calibrationMetresPerUnit: mpu })).toEqual({ source: "calibrated", metresPerUnit: mpu });
    expect(resolvePageScale({ page: 2, calibrationMetresPerUnit: mpu })).toEqual(UNCALIBRATED);
  });
  it("matches the world distance of the calibration bridge (uvToWorld)", () => {
    const scale = resolvePageScale({ page: 1, calibrationMetresPerUnit: calib.transformParams.scale });
    for (const [a, b] of [
      [[0.1, 0.2], [0.8, 0.25]],
      [[0.5, 0.5], [0.5, 0.9]],
      [[0.05, 0.95], [0.9, 0.1]],
    ] as const) {
      const wa = uvToWorld(a, page, calib);
      const wb = uvToWorld(b, page, calib);
      const world = Math.hypot(wb.x - wa.x, wb.z - wa.z);
      expect(uvDistanceMetres(a, b, page, scale)).toBeCloseTo(world, 6);
    }
  });
  it("is null without a scale and the manual scale wins over the calibration", () => {
    expect(uvDistanceMetres([0, 0], [1, 0], page, UNCALIBRATED)).toBeNull();
    expect(resolvePageScale({ page: 1, manualMetresPerUnit: 0.05, calibrationMetresPerUnit: 0.034 })).toEqual({ source: "manual", metresPerUnit: 0.05 });
    expect(uvToPage([0.5, 0.25], page)).toEqual({ x: 1192, y: 421 });
  });
  it("formats like the web: metres, centimetres, square metres; points before any scale", () => {
    const l = { kind: "length", points: [{ x: 0, y: 0 }, { x: 1000, y: 0 }] } as const;
    expect(formatMeasurement(l, calibrated)).toBe("34.00 m");
    expect(formatMeasurement({ kind: "length", points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] }, calibrated)).toBe("3.40 m");
    expect(formatMeasurement({ kind: "length", points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] }, calibrated)).toBe("34.0 cm");
    expect(formatMeasurement({ kind: "area", points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }] }, calibrated)).toBe("11.56 m²");
    expect(formatMeasurement(l, UNCALIBRATED)).toBe("1000.0 pt");
  });
});

describe("scale from a known distance", () => {
  it("two picked points and a typed length give metres per page unit", () => {
    const s = scaleFromTwoPoints({ x: 100, y: 100 }, { x: 400, y: 500 }, 10); // 500 pt apart
    expect(s).toEqual({ source: "manual", metresPerUnit: 0.02 });
    // measuring that same segment now reads the known length
    expect(formatMeasurement({ kind: "length", points: [{ x: 100, y: 100 }, { x: 400, y: 500 }] }, s!)).toBe("10.00 m");
    expect(distance({ x: 100, y: 100 }, { x: 400, y: 500 })).toBe(500);
  });
  it("rejects a zero distance and a non-positive length", () => {
    expect(scaleFromTwoPoints({ x: 1, y: 1 }, { x: 1, y: 1 }, 5)).toBeNull();
    expect(scaleFromTwoPoints({ x: 0, y: 0 }, { x: 1, y: 1 }, 0)).toBeNull();
    expect(scaleFromTwoPoints({ x: 0, y: 0 }, { x: 1, y: 1 }, -2)).toBeNull();
  });
  it("parses typed lengths with a decimal comma", () => {
    expect(parseLength("12,5")).toBe(12.5);
    expect(parseLength(" 3.2 ")).toBe(3.2);
    expect(parseLength("0")).toBeNull();
    expect(parseLength("abc")).toBeNull();
    expect(parseLength("")).toBeNull();
  });
});
