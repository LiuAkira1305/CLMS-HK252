// services/mqttService.js
// REDUNDANCY: durable queue added — DB-offline messages persist to pending_events.
// REDUNDANCY: DB replication — all writes go through dbService (primary + backup).
// REDUNDANCY: multi-channel alert — all alerts go through fallbackNotifier.
// Handles MQTT ingestion: parse → validate → history → geofence → alert → socket.

const mqtt       = require('mqtt');
const mongoose   = require('mongoose');
const User         = require('../models/User');
const geofence     = require('./geofence');
const heartbeat    = require('./heartbeat');
const dbService    = require('./dbService');
const queueService = require('./queueService');
const worker       = require('./worker');
const fallbackNotifier = require('./fallbackNotifier');
const { withRetry }    = require('../utils/retry');
const { isValidCoord } = require('../utils/validate');
const logger           = require('../utils/logger');

const MOD = 'MQTT';
const MQTT_URL = process.env.MQTT_URL;
const MQTT_USERNAME = process.env.MQTT_USERNAME;
const MQTT_PASSWORD = process.env.MQTT_PASSWORD;
const MQTT_TOPIC_PREFIX = process.env.MQTT_TOPIC_PREFIX || 'clmshk252group3/clms';

let _io = null;

// REDUNDANCY: DB reconnect triggers memory buffer flush via queueService
mongoose.connection.on('reconnected', async () => {
    logger.info(MOD, 'MongoDB reconnected. Triggering queue flush...');
    await queueService.flushMemoryBuffer();
});

function isDbConnected() {
    return mongoose.connection.readyState === 1;
}

function init(io) {
    _io = io;

    // REDUNDANCY: register processMessage with worker to allow queue replay
    worker.setProcessMessage(processMessage);
    worker.setIo(io);

    if (!MQTT_URL || !MQTT_USERNAME || !MQTT_PASSWORD) {
        logger.error(MOD, 'MQTT_URL, MQTT_USERNAME, and MQTT_PASSWORD must be set in the environment. MQTT connection disabled.');
        return;
    }

    const mqttClient = mqtt.connect(MQTT_URL, {
        username: MQTT_USERNAME,
        password: MQTT_PASSWORD
    });

    mqttClient.on('connect', () => {
        logger.info(MOD, 'Connected to HiveMQ Cloud.');
        mqttClient.subscribe(`${MQTT_TOPIC_PREFIX}/+`, (err) => {
            if (err) logger.error(MOD, `Subscribe error: ${err.message}`);
            else     logger.info(MOD, `Subscribed to ${MQTT_TOPIC_PREFIX}/+`);
        });
    });

    mqttClient.on('message', async (topic, message) => {
        // ── 1. Extract childId strictly from topic — no fallback ──────────────
        const parts   = topic.split('/');
        const childId = parts[parts.length - 1];

        if (!childId || childId === 'clms' || childId === 'undefined') {
            logger.warn(MOD, `Ambiguous topic "${topic}". Discarding.`);
            return;
        }

        // ── 2. Parse payload ──────────────────────────────────────────────────
        let data;
        try {
            data = JSON.parse(message.toString());
        } catch (_) {
            logger.warn(MOD, `Malformed JSON from ${childId}. Discarding.`);
            return;
        }

        if (data._type !== 'location') {
            return;
        }

        const lat  = data.lat;
        const lng  = data.lon;
        const batt = data.batt ?? 100;

        // ── 3. Primary validation ─────────────────────────────────────────────
        if (!isValidCoord(lat, lng)) {
            logger.warn(MOD, `Invalid coordinates from ${childId}: lat=${lat}, lng=${lng}. Discarding.`);
            return;
        }

        // ── 4. Secondary sanity check (REDUNDANCY: diversity validation) ──────
        // Verifies value reasonableness independently of isValidCoord.
        if (Math.abs(lat) < 0.001 && Math.abs(lng) < 0.001) {
            logger.warn(MOD, `Suspicious near-zero coordinates from ${childId} (${lat},${lng}). Discarding — likely GPS cold-start artifact.`);
            return;
        }

        // ── 5. DB-offline: enqueue to persistent queue instead of processing ──
        if (!isDbConnected()) {
            // REDUNDANCY: durable queue — enqueues to DB if available, else memory buffer
            await queueService.enqueue('mqtt_message', { childId, lat, lng, batt });
            logger.warn(MOD, `DB offline. Message from "${childId}" enqueued.`);
            return;
        }

        await processMessage(childId, { lat, lng, batt });
    });

    mqttClient.on('error', (err) => logger.error(MOD, `MQTT error: ${err.message}`));
}

/**
 * Core processing pipeline. Each stage is fault-isolated.
 * Exported so worker.js can replay queued events through the same path.
 */
async function processMessage(childId, { lat, lng, batt }) {
    const point = { lat, lng };

    // ── STAGE A: Resolve parent ownership before persisting data ───
    let parents;
    try {
        parents = await withRetry(
            () => User.find({ role: 'parent', 'linkedDevices.childId': childId }),
            'parent lookup'
        );
    } catch (err) {
        logger.error(MOD, `Stage B (parent lookup) failed for ${childId}: ${err.message}`);
        return;
    }

    if (!parents || parents.length === 0) {
        logger.warn(MOD, `No parent found for childId "${childId}". Discarding.`);
        return;
    }
    // ── STAGE B: Persist history only for known child-device mappings ───
    try {
        await dbService.writeHistory({ childId, location: { lat, lng, batt } });
    } catch (err) {
        logger.error(MOD, `Stage B (history) all layers failed for ${childId}: ${err.message}`);
    }

    // ── STAGE C: Per-parent processing ───────────────────────────────────────
    for (const parent of parents) {
        const device = parent.linkedDevices.find(d => d.childId === childId);
        if (!device) continue;

        // Record heartbeat
        try {
            await heartbeat.recordSeen(parent.username, childId);
        } catch (err) {
            logger.warn(MOD, `heartbeat.recordSeen failed for ${childId}: ${err.message}`);
        }

        // Emit live GPS update to parent's private room only
        _io.to(`parent:${parent.username}`).emit('gps-update', {
            childId,
            childName: device.childName,
            location:  point,
            batt
        });

        // ── STAGE D: Geofence evaluation (with diversity cross-check) ─────────
        try {
            // REDUNDANCY: geofence.evaluate now runs 2 independent algorithms internally
            const isInside = geofence.evaluate(point, device.geofence);
            if (isInside === null) continue;

            const lastState       = device.geofenceState;
            const stateChanged    = lastState !== null && lastState !== isInside;
            const firstPingOutside = lastState === null && !isInside;

            if (stateChanged || firstPingOutside) {
                const msg = isInside
                    ? `${device.childName} has entered the safe zone.`
                    : `ALERT: ${device.childName} has LEFT the safe zone!`;

                // Persist new geofenceState to DB
                await withRetry(
                    () => User.updateOne(
                        { username: parent.username, 'linkedDevices.childId': childId },
                        { $set: { 'linkedDevices.$.geofenceState': isInside } }
                    ),
                    'geofenceState update'
                );

                // ── STAGE E: Create and deliver notification ──────────────────
                const alertPayload = {
                    type:           'GEOFENCE',
                    childId,
                    childName:      device.childName,
                    parentUsername: parent.username,
                    msg,
                    isSafe:         isInside
                };

                try {
                    // REDUNDANCY: DB replication — writeNotification uses primary + backup
                    const notification = await dbService.writeNotification(alertPayload);
                    alertPayload.time = notification?.time || new Date();
                } catch (err) {
                    logger.error(MOD, `Stage E (notification create) failed for ${childId}: ${err.message}`);
                    alertPayload.time = new Date();
                }

                // REDUNDANCY: multi-channel alert — fallbackNotifier handles all channels
                await fallbackNotifier.deliverAlert(
                    _io, parent.username, 'geofence-alert', alertPayload
                );
            }
        } catch (err) {
            logger.error(MOD, `Stage D/E (geofence/alert) failed for ${childId}: ${err.message}`);
        }
    }
}

module.exports = { init, processMessage };

