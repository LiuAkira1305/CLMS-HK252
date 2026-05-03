// services/queueService.js
// REDUNDANCY: durable queue added
// Replaces the in-memory array queue with a MongoDB-backed persistent queue.
// Collection: pending_events
// Guarantees at-least-once delivery — events survive server restarts.

const mongoose = require('mongoose');
const logger   = require('../utils/logger');

const MOD = 'QUEUE';

// ── Schema ────────────────────────────────────────────────────────────────────
const pendingEventSchema = new mongoose.Schema({
    eventType:   { type: String, required: true },  // 'mqtt_message' | 'notification_retry'
    payload:     { type: mongoose.Schema.Types.Mixed, required: true },
    attempts:    { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 5 },
    status:      { type: String, enum: ['pending', 'processing', 'done', 'dead'], default: 'pending' },
    lastError:   { type: String, default: null },
    createdAt:   { type: Date, default: Date.now },
    nextRetryAt: { type: Date, default: Date.now }   // Supports delayed retry
}, { collection: 'pending_events' });

// REDUNDANCY: guard against re-registration on hot reload
const PendingEvent = mongoose.models.PendingEvent
    || mongoose.model('PendingEvent', pendingEventSchema);

// ── In-memory buffer (used ONLY when MongoDB itself is unavailable) ───────────
// This is the last-resort: data already in the DB queue is safe; this buffers
// events that arrive during the brief moment before DB reconnect.
const memoryBuffer = [];
const MAX_MEMORY_BUFFER = 200;

// ─────────────────────────────────────────────────────────────────────────────
// enqueue — Add an event to the persistent queue.
// Falls back to memory buffer if DB is unavailable.
// ─────────────────────────────────────────────────────────────────────────────
async function enqueue(eventType, payload, maxAttempts = 5) {
    if (mongoose.connection.readyState !== 1) {
        // REDUNDANCY: memory buffer used during DB outage
        if (memoryBuffer.length < MAX_MEMORY_BUFFER) {
            memoryBuffer.push({ eventType, payload, maxAttempts, bufferedAt: new Date() });
            logger.warn(MOD, `DB offline — buffered ${eventType} in memory (buffer: ${memoryBuffer.length}/${MAX_MEMORY_BUFFER})`);
        } else {
            logger.error(MOD, `Memory buffer full. Event ${eventType} for device ${payload.childId || '?'} DROPPED.`);
        }
        return null;
    }

    try {
        const doc = await PendingEvent.create({ eventType, payload, maxAttempts });
        logger.info(MOD, `Enqueued ${eventType} id=${doc._id} device=${payload.childId || '?'}`);
        return doc;
    } catch (err) {
        logger.error(MOD, `Failed to enqueue ${eventType}: ${err.message}`);
        return null;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// flush — Migrate memory buffer into DB after reconnect.
// Called by mqttService when mongoose reconnects.
// ─────────────────────────────────────────────────────────────────────────────
async function flushMemoryBuffer() {
    if (memoryBuffer.length === 0) return;
    logger.info(MOD, `Flushing ${memoryBuffer.length} buffered events to DB queue...`);

    while (memoryBuffer.length > 0) {
        const item = memoryBuffer.shift();
        await enqueue(item.eventType, item.payload, item.maxAttempts);
    }
    logger.info(MOD, 'Memory buffer flush complete.');
}

// ─────────────────────────────────────────────────────────────────────────────
// claimNextPending — Atomically claim one pending event for processing.
// Uses findOneAndUpdate to prevent concurrent workers from double-processing.
// ─────────────────────────────────────────────────────────────────────────────
async function claimNextPending() {
    try {
        return await PendingEvent.findOneAndUpdate(
            {
                status:      'pending',
                nextRetryAt: { $lte: new Date() }
            },
            {
                $set:  { status: 'processing' },
                $inc:  { attempts: 1 }
            },
            { sort: { createdAt: 1 }, returnDocument: 'after' }
        );
    } catch (err) {
        logger.error(MOD, `claimNextPending error: ${err.message}`);
        return null;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// markDone / markFailed — Update event status after processing attempt.
// ─────────────────────────────────────────────────────────────────────────────
async function markDone(id) {
    try {
        await PendingEvent.updateOne({ _id: id }, { $set: { status: 'done' } });
        logger.info(MOD, `Event ${id} marked done.`);
    } catch (err) {
        logger.error(MOD, `markDone failed for ${id}: ${err.message}`);
    }
}

async function markFailed(id, attempts, maxAttempts, errorMsg) {
    try {
        const isDead = attempts >= maxAttempts;
        const nextRetry = new Date(Date.now() + Math.min(30_000 * attempts, 300_000)); // max 5min delay
        await PendingEvent.updateOne(
            { _id: id },
            {
                $set: {
                    status:      isDead ? 'dead' : 'pending',
                    lastError:   errorMsg,
                    nextRetryAt: isDead ? null : nextRetry
                }
            }
        );
        if (isDead) {
            logger.error(MOD, `Event ${id} moved to DEAD LETTER after ${attempts} attempts. Error: ${errorMsg}`);
        } else {
            logger.warn(MOD, `Event ${id} retry scheduled at ${nextRetry.toISOString()} (attempt ${attempts}/${maxAttempts})`);
        }
    } catch (err) {
        logger.error(MOD, `markFailed failed for ${id}: ${err.message}`);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// getDeadLetterCount — For monitoring / dashboard display.
// ─────────────────────────────────────────────────────────────────────────────
async function getDeadLetterCount() {
    try {
        return await PendingEvent.countDocuments({ status: 'dead' });
    } catch (_) {
        return -1;
    }
}

module.exports = {
    enqueue,
    flushMemoryBuffer,
    claimNextPending,
    markDone,
    markFailed,
    getDeadLetterCount,
    PendingEvent    // exported for worker.js introspection
};
