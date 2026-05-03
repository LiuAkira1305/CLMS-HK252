// routes/iot.js
// Endpoint for IoT devices (child trackers) to send SOS signals.
// FIX: device auth added — validates deviceSecret against stored hash.
// FIX: retry logic on notification write.
// FIX: deliverAlert used for guaranteed socket + fallback delivery.

const express      = require('express');
const router       = express.Router();
const bcrypt       = require('bcrypt');
const User         = require('../models/User');
const Notification = require('../models/Notification');
const { withRetry }    = require('../utils/retry');
const { deliverAlert } = require('../utils/alertFallback');

// POST /iot/sos
// Body: { childId: string, deviceSecret: string }
router.post('/sos', async (req, res) => {
    try {
        const { childId, deviceSecret } = req.body;

        if (!childId)
            return res.status(400).json({ error: 'childId is required.' });

        // Find the parent(s) that own this device
        const parents = await User.find({
            role: 'parent',
            'linkedDevices.childId': childId
        });

        if (parents.length === 0)
            return res.status(404).json({ error: 'Unknown device.' });

        const io = req.app.get('io');
        let authPassed = false;

        for (const parent of parents) {
            const device = parent.linkedDevices.find(d => d.childId === childId);
            if (!device) continue;

            // FIX: device authentication — compare submitted secret against stored hash.
            // If no secret is configured for the device (null), reject the request.
            if (!device.deviceSecret) {
                console.warn(`[IoT] SOS from "${childId}" rejected: no deviceSecret configured.`);
                continue;
            }

            const secretMatch = await bcrypt.compare(String(deviceSecret || ''), device.deviceSecret);
            if (!secretMatch) {
                console.warn(`[IoT] SOS from "${childId}" rejected: invalid deviceSecret.`);
                continue; // Try other parents, but log the mismatch
            }

            authPassed = true;
            const msg = `SOS EMERGENCY from ${device.childName}!`;

            // FIX: retry notification write — SOS is critical, must not be lost
            let notification;
            try {
                notification = await withRetry(
                    () => Notification.create({
                        type:           'SOS',
                        childId,
                        childName:      device.childName,
                        parentUsername: parent.username,
                        msg,
                        isSafe:         false
                    }),
                    'SOS notification write'
                );
            } catch (err) {
                // FIX: even if DB write fails, still emit alert — safety > persistence
                console.error(`[IoT] SOS DB write failed for ${childId}: ${err.message}. Emitting without persisting.`);
            }

            // FIX: deliverAlert handles socket + fallback if parent is offline
            await deliverAlert(io, parent.username, 'sos-alert', {
                childId,
                childName:      device.childName,
                parentUsername: parent.username,
                msg,
                type:           'SOS',
                time:           notification?.time || new Date()
            });

            console.warn(`[IoT] SOS alert delivered for device "${childId}" (parent: ${parent.username})`);
        }

        if (!authPassed) {
            return res.status(401).json({ error: 'Device authentication failed.' });
        }

        res.json({ success: true });
    } catch (err) {
        console.error('[IoT] SOS error:', err);
        res.status(500).json({ error: 'Server error.' });
    }
});

// POST /iot/register-secret
// Allows a parent (via session) to set or rotate the deviceSecret for their device.
// The secret is stored as a bcrypt hash — never in plain text.
const { requireRole } = require('../middleware/auth');

router.post('/register-secret', requireRole('parent'), async (req, res) => {
    try {
        const { childId, secret } = req.body;
        if (!childId || !secret || secret.length < 8)
            return res.json({ success: false, error: 'childId and secret (min 8 chars) are required.' });

        // FIX: store secret as bcrypt hash — plain text never touches DB
        const secretHash = await bcrypt.hash(secret, 12);

        const result = await User.updateOne(
            { username: req.session.user.username, 'linkedDevices.childId': childId },
            { $set: { 'linkedDevices.$.deviceSecret': secretHash } }
        );

        if (result.matchedCount === 0)
            return res.json({ success: false, error: 'Device not found or not owned by you.' });

        res.json({ success: true, message: 'Device secret updated. Configure the same secret on the hardware.' });
    } catch (err) {
        console.error('[IoT] Register secret error:', err);
        res.json({ success: false, error: 'Server error.' });
    }
});

module.exports = router;
