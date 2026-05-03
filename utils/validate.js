// utils/validate.js
// FIX: strict coordinate and geofence validation added.
// All numeric checks use Number.isFinite to reject NaN and Infinity.

/**
 * Returns true if `lat` and `lng` are valid WGS-84 coordinates.
 */
function isValidCoord(lat, lng) {
    return (
        Number.isFinite(lat) && lat >= -90  && lat <= 90 &&
        Number.isFinite(lng) && lng >= -180 && lng <= 180
    );
}

/**
 * Validates radius geofence input.
 * centre must be a valid WGS-84 coordinate.
 */
function validateRadiusGeofence(lat, lng) {
    const errors = [];
    const flatLat = parseFloat(lat);
    const flatLng = parseFloat(lng);
    if (!isValidCoord(flatLat, flatLng))
        errors.push('Radius centre lat/lng must be valid WGS-84 coordinates.');
    return { valid: errors.length === 0, errors, lat: flatLat, lng: flatLng };
}

/**
 * Validates rectangle geofence input.
 * Checks all 4 bounds exist, are valid WGS-84, and form a sensible box.
 */
function validateRectangleGeofence(north, south, east, west) {
    const errors = [];
    const n = parseFloat(north);
    const s = parseFloat(south);
    const e = parseFloat(east);
    const w = parseFloat(west);

    if (!Number.isFinite(n) || !Number.isFinite(s) ||
        !Number.isFinite(e) || !Number.isFinite(w))
        errors.push('All four bounds must be numeric.');
    if (n < s) errors.push('North must be >= South.');
    if (e < w) errors.push('East must be >= West.');
    if (n > 90 || s < -90) errors.push('Latitude bounds out of WGS-84 range.');
    if (e > 180 || w < -180) errors.push('Longitude bounds out of WGS-84 range.');

    return { valid: errors.length === 0, errors, north: n, south: s, east: e, west: w };
}

module.exports = { isValidCoord, validateRadiusGeofence, validateRectangleGeofence };
