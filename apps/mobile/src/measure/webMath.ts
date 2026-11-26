/**
 * The web Documents module's plan-measurement math, reused as is (pure TypeScript, no React): page-unit geometry,
 * calibration scale resolution and the length/area formatting. Imported by path because the package entry also
 * exports the web's React layer, which the tablet does not use.
 */
export { centroid, distance, midpoint, polygonArea, polygonPerimeter, polylineLength, segmentLengths, snapToPoints, type Point } from "../../../../vendor/free-field/packages/ff-viewer-tools/src/pdfMeasure/geometry";
export { pickCalibrationScale, resolvePageScale, scaleFromCalibration, scaleFromTwoPoints, toMetres, UNCALIBRATED, type LengthUnit, type PageScale } from "../../../../vendor/free-field/packages/ff-viewer-tools/src/pdfMeasure/scale";
export { formatArea, formatLength, scaleBadgeText } from "../../../../vendor/free-field/packages/ff-viewer-tools/src/pdfMeasure/format";
