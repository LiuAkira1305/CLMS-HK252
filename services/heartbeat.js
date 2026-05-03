// services/heartbeat.js
// Runs on a fixed interval. Marks devices OFFLINE if no GPS update
// has arrived within OFFLINE_THRESHOLD_MS. Persists offline state to DB.
// REDUNDANCY: offline alerts delivered via fallbackNotifier (multi-channel).

const User         = require('../models/User');
const Notification = require('../models/Notification');
const { withRetry }        = require('../utils/retry');
const fallbackNotifier     = require('./fallbackNotifier');
const logger               = require('../utils/logger');

const MOD = 'HEARTBEAT';
const CHECK_INTERVAL_MS    = 60_000;
const OFFLINE_THRESHOLD_MS = 300_000;

// FIX: lastSeen and offlineAlerted persist in DB (childDeviceSchema.lastSeen)
// but we also maintain an in-process map as a fast lookup cache.
const lastSeenCache   = {}; // { "<parentUsername>:<childId>": Date }
const offlineAlertsSet = new Set(); // Tracks which devices already have an open offline alert

let _io = null;

/**
 * Called by mqttService.js on every valid GPS ping.
 * Updates the in-memory cache AND the DB field.
 */
async function recordSeen(parentUsername, childId) {
    const key = `${parentUsername}:${childId}`;
    lastSeenCache[key] = new Date();
    try {
        await User.updateOne(
            { username: parentUsername, 'linkedDevices.childId': childId },
            { $set: { 'linkedDevices.$.lastSeen': new Date() } }
        );
        offlineAlertsSet.delete(key);
    } catch (err) {
        logger.warn(MOD, `Could not persist lastSeen for ${childId}: ${err.message}`);
    }
}

/**
 * Main check loop. Runs every CHECK_INTERVAL_MS.
 */
async function runCheck() {
    try {
        const parents = await User.find({ role: 'parent' }).lean();
        const now = Date.now();
        for (const parent of parents) {
            for (const device of parent.linkedDevices) {
                const key      = `${parent.username}:${device.childId}`;
                const lastSeen = device.lastSeen ? new Date(device.lastSeen).getTime() : null;

                if (!lastSeen) continue;

                const elapsed = now - lastSeen;

                if (elapsed > OFFLINE_THRESHOLD_MS && !offlineAlertsSet.has(key)) {
                    offlineAlertsSet.add(key);
                    const msg = `Device "${device.childName}" has not sent a location update for more than 5 minutes. It may be offline or out of coverage.`;

                    try {
                        await withRetry(
                            () => Notification.create({
                                type:           'OFFLINE',
                                childId:        device.childId,
                                childName:      device.childName,
                                parentUsername: parent.username,
                                msg,
                                isSafe:         false
                            }),
                            'heartbeat notification write'
                        );

                        // REDUNDANCY: multi-channel alert via fallbackNotifier
                        await fallbackNotifier.deliverAlert(_io, parent.username, 'device-offline', {
                            childId:        device.childId,
                            childName:      device.childName,
                            parentUsername: parent.username,
                            msg,
                            type:           'OFFLINE',
                            time:           new Date()
                        });

                        logger.warn(MOD, `OFFLINE alert issued for device "${device.childId}" (parent: ${parent.username})`);
                    } catch (err) {
                        logger.error(MOD, `Failed to issue offline alert for ${device.childId}: ${err.message}`);
                    }
                }
            }
        }
    } catch (err) {
        logger.error(MOD, `Check loop error: ${err.message}`);
    }
}

/**
 * Starts the heartbeat monitoring service.
 * Called from server.js after DB connection is ready.
 */
function init(io) {
    _io = io;
    setInterval(runCheck, CHECK_INTERVAL_MS);
    logger.info(MOD, `Monitor started. Interval=${CHECK_INTERVAL_MS/1000}s, Threshold=${OFFLINE_THRESHOLD_MS/60000}min.`);
}

module.exports = { init, recordSeen };
