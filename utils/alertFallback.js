// utils/alertFallback.js
// FIX: fallback alert channel added — ensures alerts are never silently lost
// when Socket.io cannot reach the parent (browser closed, connection dropped).
//
// Current implementation: structured log to stderr + in-memory delivery log.
// Replace sendEmail() stub with nodemailer or similar for production.

const fs   = require('fs');
const path = require('path');

// Delivery log file path
const LOG_PATH = path.join(__dirname, '..', 'logs', 'alert_delivery.log');

// Ensure log directory exists on startup
try {
    const logDir = path.dirname(LOG_PATH);
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
} catch (_) {}

/**
 * Logs a structured delivery record to the alert_delivery.log file.
 * This ensures an audit trail exists even when WebSocket delivery fails.
 *
 * @param {string} channel    - 'websocket' | 'fallback-log'
 * @param {string} status     - 'sent' | 'failed'
 * @param {object} payload    - The alert payload
 */
function logDelivery(channel, status, payload) {
    const record = JSON.stringify({
        timestamp: new Date().toISOString(),
        channel,
        status,
        parentUsername: payload.parentUsername,
        type:           payload.type,
        childId:        payload.childId,
        msg:            payload.msg
    });
    // FIX: append-only delivery log — never overwrites, survives restarts
    try {
        fs.appendFileSync(LOG_PATH, record + '\n');
    } catch (err) {
        console.error('[AlertFallback] Could not write to delivery log:', err.message);
    }
}

/**
 * Emits a Socket.io event to the parent's private room.
 * Logs delivery status. If room has zero connected sockets (parent offline),
 * triggers the fallback channel to prevent silent loss.
 *
 * @param {object} io
 * @param {string} parentUsername
 * @param {string} event            - Socket.io event name
 * @param {object} payload
 */
async function deliverAlert(io, parentUsername, event, payload) {
    const room = `parent:${parentUsername}`;

    // FIX: check if parent has active socket connections before emitting
    const sockets = await io.in(room).fetchSockets();
    const parentOnline = sockets.length > 0;

    // Always emit (Socket.io drops gracefully if room is empty)
    io.to(room).emit(event, payload);

    if (parentOnline) {
        logDelivery('websocket', 'sent', { parentUsername, ...payload });
        console.info(`[Alert] Delivered '${event}' via WebSocket to ${parentUsername}`);
    } else {
        // FIX: parent offline — trigger fallback channel
        logDelivery('websocket', 'failed', { parentUsername, ...payload });
        triggerFallback(parentUsername, event, payload);
    }
}

/**
 * Fallback channel stub.
 * In production: replace with email (nodemailer), SMS (Twilio), or push notification.
 */
function triggerFallback(parentUsername, event, payload) {
    // FIX: fallback-log channel — structured stderr output as secondary delivery
    const fallbackMsg = `[FALLBACK ALERT] Parent "${parentUsername}" is OFFLINE. ` +
        `Event: ${event} | Child: ${payload.childId} | Message: ${payload.msg}`;

    console.error(fallbackMsg);
    logDelivery('fallback-log', 'sent', { parentUsername, ...payload });

    // TODO (production): sendEmail(parentUsername, payload);
}

module.exports = { deliverAlert, logDelivery };
