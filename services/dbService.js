// services/dbService.js
// REDUNDANCY: DB replication added
// Provides a write-through dual-layer: primary MongoDB + secondary backup collection.
// On primary write failure, falls back to backup collection and logs the failover event.
// All consumers call dbService.writeHistory() / dbService.writeNotification()
// instead of calling Model.create() directly.

const mongoose   = require('mongoose');
const fs         = require('fs');
const path       = require('path');
const History      = require('../models/History');
const Notification = require('../models/Notification');
const { withRetry } = require('../utils/retry');
const logger        = require('../utils/logger');

// ── Backup collection schemas (lightweight mirrors) ──────────────────────────
// Stored in the same MongoDB instance under a separate collection.
// In a real deployment this would point to a different host/replica set.
const backupHistorySchema = new mongoose.Schema({
    childId:    String,
    location:   { lat: Number, lng: Number, batt: Number },
    time:       { type: Date, default: Date.now },
    sourceFail: Boolean   // true = written because primary failed
}, { collection: 'backup_history', timestamps: false });

const backupNotifSchema = new mongoose.Schema({
    type:           String,
    childId:        String,
    childName:      String,
    parentUsername: String,
    msg:            String,
    isSafe:         Boolean,
    deliveryStatus: { type: String, default: 'pending' },
    time:           { type: Date, default: Date.now },
    sourceFail:     Boolean
}, { collection: 'backup_notifications', timestamps: false });

// REDUNDANCY: guard against re-registration of the same model
const BackupHistory = mongoose.models.BackupHistory
    || mongoose.model('BackupHistory', backupHistorySchema);
const BackupNotification = mongoose.models.BackupNotification
    || mongoose.model('BackupNotification', backupNotifSchema);

// ── File-based tertiary fallback (last resort when both collections fail) ─────
const FALLBACK_DIR  = path.join(__dirname, '..', 'logs');
const FALLBACK_FILE = path.join(FALLBACK_DIR, 'db_fallback.ndjson');

function ensureFallbackDir() {
    try { if (!fs.existsSync(FALLBACK_DIR)) fs.mkdirSync(FALLBACK_DIR, { recursive: true }); }
    catch (_) {}
}
ensureFallbackDir();

function writeFallbackFile(type, data) {
    try {
        const record = JSON.stringify({ type, data, at: new Date().toISOString() });
        fs.appendFileSync(FALLBACK_FILE, record + '\n');
        logger.warn('DBSVC', `Tertiary file fallback used for ${type}.`);
    } catch (err) {
        logger.error('DBSVC', `CRITICAL: tertiary fallback write failed: ${err.message}`);
    }
}

// ── isDbConnected helper ──────────────────────────────────────────────────────
function isDbConnected() {
    return mongoose.connection.readyState === 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// writeHistory
// Layer 1: Primary MongoDB (History collection)
// Layer 2: BackupHistory collection (same instance, separate collection)
// Layer 3: File-based NDJSON log
// ─────────────────────────────────────────────────────────────────────────────
async function writeHistory(payload) {
    // Layer 1 — primary
    try {
        const doc = await withRetry(
            () => History.create(payload),
            'history-primary'
        );
        logger.info('DBSVC', `History written to primary for device ${payload.childId}`);
        // REDUNDANCY: DB replication — mirror to backup collection asynchronously
        BackupHistory.create({ ...payload, sourceFail: false }).catch(e =>
            logger.warn('DBSVC', `Backup history mirror failed (non-critical): ${e.message}`)
        );
        return doc;
    } catch (primaryErr) {
        logger.error('DBSVC', `Primary history write failed for ${payload.childId}: ${primaryErr.message}. Attempting backup.`);

        // Layer 2 — backup collection
        try {
            const doc = await withRetry(
                () => BackupHistory.create({ ...payload, sourceFail: true }),
                'history-backup'
            );
            logger.warn('DBSVC', `FAILOVER: History for ${payload.childId} written to backup collection.`);
            return doc;
        } catch (backupErr) {
            logger.error('DBSVC', `Backup history write failed for ${payload.childId}: ${backupErr.message}. Using file fallback.`);
            // Layer 3 — file
            writeFallbackFile('history', payload);
            return null;
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// writeNotification
// Layer 1: Primary Notification collection
// Layer 2: BackupNotification collection
// Layer 3: File-based NDJSON log
// ─────────────────────────────────────────────────────────────────────────────
async function writeNotification(payload) {
    // Layer 1 — primary
    try {
        const doc = await withRetry(
            () => Notification.create(payload),
            'notification-primary'
        );
        logger.info('DBSVC', `Notification written to primary: type=${payload.type} parent=${payload.parentUsername}`);
        // REDUNDANCY: DB replication — mirror backup asynchronously
        BackupNotification.create({ ...payload, sourceFail: false }).catch(e =>
            logger.warn('DBSVC', `Backup notification mirror failed (non-critical): ${e.message}`)
        );
        return doc;
    } catch (primaryErr) {
        logger.error('DBSVC', `Primary notification write failed: ${primaryErr.message}. Attempting backup.`);

        // Layer 2 — backup collection
        try {
            const doc = await withRetry(
                () => BackupNotification.create({ ...payload, sourceFail: true }),
                'notification-backup'
            );
            logger.warn('DBSVC', `FAILOVER: Notification written to backup collection for parent ${payload.parentUsername}.`);
            return doc;
        } catch (backupErr) {
            logger.error('DBSVC', `Backup notification write failed: ${backupErr.message}. Using file fallback.`);
            // Layer 3 — file
            writeFallbackFile('notification', payload);
            return null;
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// readHistoryWithFallback
// Tries primary, then backup collection if primary fails.
// ─────────────────────────────────────────────────────────────────────────────
async function readHistoryWithFallback(childId, limit = 100) {
    try {
        return await History.find({ childId }).sort({ time: -1 }).limit(limit).lean();
    } catch (err) {
        logger.warn('DBSVC', `Primary history read failed for ${childId}. Falling back to backup: ${err.message}`);
        try {
            return await BackupHistory.find({ childId }).sort({ time: -1 }).limit(limit).lean();
        } catch (backupErr) {
            logger.error('DBSVC', `Backup history read also failed for ${childId}: ${backupErr.message}`);
            return [];
        }
    }
}

module.exports = {
    writeHistory,
    writeNotification,
    readHistoryWithFallback,
    isDbConnected
};
