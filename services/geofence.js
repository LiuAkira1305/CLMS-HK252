// services/geofence.js
// Pure math functions. No I/O, no DB access.
// REDUNDANCY: algorithm diversity added — secondary sanity verifier cross-checks primary result.

const logger = require('../utils/logger');
const MOD = 'GEOFENCE';

const EARTH_RADIUS_M = 6371e3;
const RADIUS_MODE_KM = 1000; // Fixed 1 km for radius mode

// Haversine distance in meters between two lat/lng points.
function distanceMeters(p1, p2) {
    const lat1 = p1.lat * Math.PI / 180;
    const lat2 = p2.lat * Math.PI / 180;
    const dLat = (p2.lat - p1.lat) * Math.PI / 180;
    const dLng = (p2.lng - p1.lng) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2
        + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Primary: Haversine distance check
function isInsideRadius(point, gf) {
    return distanceMeters(point, { lat: gf.lat, lng: gf.lng }) <= RADIUS_MODE_KM;
}

// REDUNDANCY: diversity — Secondary radius check uses flat-earth approximation (different algorithm).
function isInsideRadiusSecondary(point, gf) {
    const LAT_DEG_M  = 111_320;
    const LNG_DEG_M  = 111_320 * Math.cos(gf.lat * Math.PI / 180);
    const dy = (point.lat - gf.lat) * LAT_DEG_M;
    const dx = (point.lng - gf.lng) * LNG_DEG_M;
    return Math.sqrt(dx * dx + dy * dy) <= RADIUS_MODE_KM;
}

// Primary: AABB bounding-box check
function isInsideRectangle(point, gf) {
    return point.lat >= gf.south
        && point.lat <= gf.north
        && point.lng >= gf.west
        && point.lng <= gf.east;
}

// REDUNDANCY: diversity — Secondary rectangle check validates bounds are sane before comparing.
function isInsideRectangleSecondary(point, gf) {
    if (!Number.isFinite(gf.north) || !Number.isFinite(gf.south) ||
        !Number.isFinite(gf.east)  || !Number.isFinite(gf.west)) {
        return null;
    }
    const inLat = point.lat > gf.south && point.lat < gf.north;
    const inLng = point.lng > gf.west  && point.lng < gf.east;
    return inLat && inLng;
}

// Primary: Ray-casting point-in-polygon.
function isInsidePolygon(point, points) {
    const { lat: y, lng: x } = point;
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const xi = points[i].lng, yi = points[i].lat;
        const xj = points[j].lng, yj = points[j].lat;
        const intersect = ((yi > y) !== (yj > y))
            && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}

// REDUNDANCY: diversity — Winding-number algorithm as cross-check.
function isInsidePolygonSecondary(point, points) {
    const { lat: y, lng: x } = point;
    let winding = 0;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        if (points[j].lat <= y) {
            if (points[i].lat > y) {
                if (((points[i].lng - points[j].lng) * (y - points[j].lat) -
                     (x - points[j].lng) * (points[i].lat - points[j].lat)) > 0) winding++;
            }
        } else {
            if (points[i].lat <= y) {
                if (((points[i].lng - points[j].lng) * (y - points[j].lat) -
                     (x - points[j].lng) * (points[i].lat - points[j].lat)) < 0) winding--;
            }
        }
    }
    return winding !== 0;
}

/**
 * Evaluates whether a point is inside the configured geofence.
 * REDUNDANCY: runs both primary and secondary algorithms and logs any mismatch.
 * Returns the primary result; logs a diversity warning if results diverge.
 * Returns null if no geofence is configured.
 *
 * @param {{lat, lng}} point
 * @param {{mode, lat, lng, north, south, east, west, points}} gf
 * @returns {boolean|null}
 */
function evaluate(point, gf) {
    if (!gf || !gf.mode) return null;

    let primary   = null;
    let secondary = null;

    if (gf.mode === 'radius') {
        primary   = isInsideRadius(point, gf);
        secondary = isInsideRadiusSecondary(point, gf);
    } else if (gf.mode === 'rectangle') {
        primary   = isInsideRectangle(point, gf);
        secondary = isInsideRectangleSecondary(point, gf);
    } else if (gf.mode === 'polygon') {
        if (!Array.isArray(gf.points) || gf.points.length < 3) return null;
        primary   = isInsidePolygon(point, gf.points);
        secondary = isInsidePolygonSecondary(point, gf.points);
    } else {
        return null;
    }

    // REDUNDANCY: diversity cross-check — log mismatch but trust primary result.
    if (secondary !== null && primary !== secondary) {
        logger.warn(MOD,
            `Algorithm diversity MISMATCH for device at (${point.lat},${point.lng}) ` +
            `mode=${gf.mode}: primary=${primary}, secondary=${secondary}. ` +
            `Using primary result. Device may be near boundary.`
        );
    }

    return primary;
}

module.exports = { evaluate, RADIUS_MODE_KM };
