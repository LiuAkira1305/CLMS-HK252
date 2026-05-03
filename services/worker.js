// services/worker.js
// REDUNDANCY: durable queue worker added
// Polls pending_events collection every POLL_INTERVAL_MS.
// Processes each event type by dispatching to the appropriate handler.
// Guarantees at-least-once processing with dead-letter on exhaustion.

const mongoose     = require('mongoose');
const queueService = require('./queueService');
const logger       = require('../utils/logger');

const MOD = 'WORKER';
const POLL_INTERVAL_MS = 5_000;  // Check every 5 seconds

let _processMessage = null;  // Injected from mqttService to avoid circular deps
let _io             = null;

/**
 * Inject the processMessage function from mqttService.
 * Called from mqttService.init() to avoid circular requires.
 */
function setProcessMessage(fn) {
    _processMessage = fn;
}

function setIo(io) {
    _io = io;
}

// ─────────────────────────────────────────────────────────────────────────────
// processEvent — Dispatch a single claimed event to its handler.
// ─────────────────────────────────────────────────────────────────────────────
async function processEvent(event) {
    const { _id, eventType, payload, attempts, maxAttempts } = event;

    logger.info(MOD, `Processing event id=${_id} type=${eventType} attempt=${attempts}/${maxAttempts}`);

    try {
        if (eventType === 'mqtt_message') {
            // REDUNDANCY: queued GPS events replayed via the same processMessage pipeline
            if (!_processMessage) throw new Error('processMessage handler not registered.');
            await _processMessage(payload.childId, {
                lat:  payload.lat,
                lng:  payload.lng,
                batt: payload.batt || 100
            });

        } else if (eventType === 'notification_retry') {
            // REDUNDANCY: failed notification delivery retried via fallbackNotifier
            const fallbackNotifier = require('./fallbackNotifier');
            await fallbackNotifier.retryDelivery(_io, payload);

        } else {
            logger.warn(MOD, `Unknown event type "${eventType}" for id=${_id}. Marking dead.`);
            await queueService.markFailed(_id, maxAttempts, maxAttempts, 'Unknown event type');
            return;
        }

        await queueService.markDone(_id);
        logger.info(MOD, `Event id=${_id} completed successfully.`);

    } catch (err) {
        logger.warn(MOD, `Event id=${_id} failed: ${err.message}`);
        await queueService.markFailed(_id, attempts, maxAttempts, err.message);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// poll — Main worker loop. Claims and processes one event per tick.
// ─────────────────────────────────────────────────────────────────────────────
async function poll() {
    if (mongoose.connection.readyState !== 1) return; // Skip if DB offline

    try {
        const event = await queueService.claimNextPending();
        if (!event) return; // Nothing to process

        await processEvent(event);

        // REDUNDANCY: immediately check for more events without waiting for next interval
        setImmediate(poll);
    } catch (err) {
        logger.error(MOD, `Poll error: ${err.message}`);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// init — Start the polling loop.
// Also flushes memory buffer when DB reconnects.
// ─────────────────────────────────────────────────────────────────────────────
function init(io) {
    _io = io;

    setInterval(poll, POLL_INTERVAL_MS);
    logger.info(MOD, `Queue worker started. Polling every ${POLL_INTERVAL_MS / 1000}s.`);

    // REDUNDANCY: flush in-memory buffer to DB queue on reconnect
    mongoose.connection.on('reconnected', async () => {
        logger.info(MOD, 'MongoDB reconnected. Flushing memory buffer to persistent queue...');
        await queueService.flushMemoryBuffer();
    });

    // Log dead-letter queue size periodically for monitoring
    setInterval(async () => {
        const dead = await queueService.getDeadLetterCount();
        if (dead > 0) {
            logger.warn(MOD, `Dead-letter queue contains ${dead} unprocessable events. Manual review required.`);
        }
    }, 5 * 60_000); // Every 5 minutes
}

module.exports = { init, setProcessMessage, setIo };
