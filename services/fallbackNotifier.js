// services/fallbackNotifier.js
// REDUNDANCY: multi-channel alert delivery added
// Manages full delivery lifecycle: pending → sent → confirmed → failed
// Channel 1: WebSocket (primary)
// Channel 2: Structured log file (secondary — simulated email)
// Channel 3: Queue retry (tertiary — re-enqueues failed deliveries)

const fs   = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const MOD = 'NOTIFIER';

const LOG_DIR           = path.join(__dirname, '..', 'logs');
const DELIVERY_LOG_FILE = path.join(LOG_DIR, 'alert_delivery.log');
const SIMULATED_EMAIL_FILE = path.join(LOG_DIR, 'simulated_email.log');

try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
} catch (_) {}

// Delivery state constants
const STATUS = {
    PENDING:   'pending',
    SENT:      'sent',
    CONFIRMED: 'confirmed',
    FAILED:    'failed'
};

// ─────────────────────────────────────────────────────────────────────────────
// logDelivery — Append a structured delivery record to alert_delivery.log
// ─────────────────────────────────────────────────────────────────────────────
function logDelivery(channel, status, payload) {
    const record = JSON.stringify({
        at:             new Date().toISOString(),
        channel,
        status,
        parentUsername: payload.parentUsername,
        type:           payload.type,
        childId:        payload.childId,
        msg:            payload.msg
    });
    try {
        fs.appendFileSync(DELIVERY_LOG_FILE, record + '\n');
    } catch (err) {
        logger.error(MOD, `Delivery log write failed: ${err.message}`);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// simulateEmail — Channel 2: write to simulated_email.log
// Replace this function body with nodemailer.sendMail() for real email.
// ─────────────────────────────────────────────────────────────────────────────
function simulateEmail(parentUsername, payload) {
    const record = JSON.stringify({
        at:      new Date().toISOString(),
        to:      `${parentUsername}@clms.local`,
        subject: `[CLMS ALERT] ${payload.type} — ${payload.childName || payload.childId}`,
        body:    payload.msg
    });
    try {
        fs.appendFileSync(SIMULATED_EMAIL_FILE, record + '\n');
        logger.info(MOD, `Simulated email written for parent "${parentUsername}": ${payload.type}`);
        return true;
    } catch (err) {
        logger.error(MOD, `Simulated email write failed for "${parentUsername}": ${err.message}`);
        return false;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// deliverAlert — Main entry point. Tries all channels in order.
// Returns final delivery status string.
// ─────────────────────────────────────────────────────────────────────────────
async function deliverAlert(io, parentUsername, event, payload) {
    const room = `parent:${parentUsername}`;
    let finalStatus = STATUS.PENDING;

    // ── Channel 1: WebSocket ──────────────────────────────────────────────────
    let wsOnline = false;
    try {
        const sockets = await io.in(room).fetchSockets();
        wsOnline = sockets.length > 0;
    } catch (err) {
        logger.warn(MOD, `Cannot check socket room for "${parentUsername}": ${err.message}`);
    }

    io.to(room).emit(event, payload);

    if (wsOnline) {
        finalStatus = STATUS.SENT;
        logDelivery('websocket', STATUS.SENT, { parentUsername, ...payload });
        logger.info(MOD, `Alert "${event}" delivered via WebSocket to parent "${parentUsername}"`);
    } else {
        logDelivery('websocket', STATUS.FAILED, { parentUsername, ...payload });
        logger.warn(MOD, `WebSocket delivery FAILED (parent offline): "${parentUsername}". Activating Channel 2.`);

        // ── Channel 2: Simulated email ──────────────────────────────────────
        const emailSent = simulateEmail(parentUsername, payload);
        if (emailSent) {
            finalStatus = STATUS.SENT;
            logDelivery('simulated-email', STATUS.SENT, { parentUsername, ...payload });
        } else {
            // ── Channel 3: Re-enqueue for retry ────────────────────────────
            // REDUNDANCY: failed delivery re-enters the durable queue
            try {
                const queueService = require('./queueService');
                await queueService.enqueue('notification_retry', {
                    parentUsername,
                    event,
                    payload
                }, 3); // max 3 retry attempts
                finalStatus = STATUS.PENDING;
                logDelivery('queue-retry', STATUS.PENDING, { parentUsername, ...payload });
                logger.warn(MOD, `Alert re-enqueued for retry (parentUsername=${parentUsername})`);
            } catch (qErr) {
                finalStatus = STATUS.FAILED;
                logDelivery('queue-retry', STATUS.FAILED, { parentUsername, ...payload });
                logger.error(MOD, `All delivery channels failed for parent "${parentUsername}": ${qErr.message}`);
            }
        }
    }

    return finalStatus;
}

// ─────────────────────────────────────────────────────────────────────────────
// retryDelivery — Called by worker.js for notification_retry events.
// Attempts WebSocket → simulated email only (no further re-queue to avoid loops).
// ─────────────────────────────────────────────────────────────────────────────
async function retryDelivery(io, { parentUsername, event, payload }) {
    const room = `parent:${parentUsername}`;

    const sockets = await io.in(room).fetchSockets().catch(() => []);
    const wsOnline = sockets.length > 0;

    if (wsOnline) {
        io.to(room).emit(event, payload);
        logDelivery('websocket-retry', STATUS.SENT, { parentUsername, ...payload });
        logger.info(MOD, `Retry delivery via WebSocket succeeded for parent "${parentUsername}"`);
    } else {
        const emailSent = simulateEmail(parentUsername, payload);
        const ch = emailSent ? 'simulated-email-retry' : 'all-channels-exhausted';
        const st = emailSent ? STATUS.SENT : STATUS.FAILED;
        logDelivery(ch, st, { parentUsername, ...payload });

        if (!emailSent) {
            logger.error(MOD, `Retry delivery EXHAUSTED all channels for parent "${parentUsername}". Alert permanently logged.`);
        }
    }
}

module.exports = { deliverAlert, retryDelivery, logDelivery };
