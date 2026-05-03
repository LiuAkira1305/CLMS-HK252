// routes/parent.js
const express      = require('express');
const router       = express.Router();
const User         = require('../models/User');
const Notification = require('../models/Notification');
const { requireRole } = require('../middleware/auth');
const { RADIUS_MODE_KM } = require('../services/geofence');
const { validateRadiusGeofence, validateRectangleGeofence } = require('../utils/validate');
// REDUNDANCY: DB replication — history reads use dbService (primary + backup fallback)
const dbService = require('../services/dbService');

router.use(requireRole('parent'));

// ─── DEVICE MANAGEMENT ────────────────────────────────────────────────────────

// POST /parent/add-device
// Links a new child IoT device to this parent's account.
router.post('/add-device', async (req, res) => {
    try {
        const { childId, childName } = req.body;
        if (!childId || !childName)
            return res.send('<script>alert("Device ID and child name are required."); history.back();</script>');

        const parent = await User.findOne({ username: req.session.user.username });

        // Prevent duplicate device ID under the same parent
        if (parent.linkedDevices.find(d => d.childId === childId.trim()))
            return res.send('<script>alert("This device is already linked."); window.location="/";</script>');

        parent.linkedDevices.push({
            childId:  childId.trim(),
            childName: childName.trim(),
            geofence: { mode: null }
        });
        await parent.save();
        res.redirect('/');
    } catch (err) {
        console.error('[Parent] Add device error:', err);
        res.status(500).send('Server error.');
    }
});

// POST /parent/remove-device
router.post('/remove-device', async (req, res) => {
    try {
        const { childId } = req.body;
        await User.updateOne(
            { username: req.session.user.username },
            { $pull: { linkedDevices: { childId } } }
        );
        res.redirect('/');
    } catch (err) {
        console.error('[Parent] Remove device error:', err);
        res.status(500).send('Server error.');
    }
});

// ─── GEOFENCE MANAGEMENT ─────────────────────────────────────────────────────

// POST /parent/set-geofence
// Accepts mode = 'radius', 'rectangle', or 'polygon'.
router.post('/set-geofence', async (req, res) => {
    try {
        const { childId, mode, lat, lng, north, south, east, west, points } = req.body;

        const parent = await User.findOne({ username: req.session.user.username });
        if (!parent) return res.json({ success: false, error: 'Parent not found.' });

        const deviceIdx = parent.linkedDevices.findIndex(d => d.childId === childId);
        if (deviceIdx === -1) return res.json({ success: false, error: 'Device not found.' });

        if (mode === 'radius') {
            const v = validateRadiusGeofence(lat, lng);
            if (!v.valid) return res.json({ success: false, error: v.errors.join(' ') });
            parent.linkedDevices[deviceIdx].geofence = {
                mode: 'radius',
                lat:  v.lat,
                lng:  v.lng
            };
        } else if (mode === 'rectangle') {
            const v = validateRectangleGeofence(north, south, east, west);
            if (!v.valid) return res.json({ success: false, error: v.errors.join(' ') });
            parent.linkedDevices[deviceIdx].geofence = {
                mode:  'rectangle',
                north: v.north,
                south: v.south,
                east:  v.east,
                west:  v.west
            };
        } else if (mode === 'polygon') {
            if (!Array.isArray(points) || points.length < 3)
                return res.json({ success: false, error: 'Polygon requires at least 3 points.' });
            const validated = [];
            for (const pt of points) {
                const ptLat = parseFloat(pt.lat);
                const ptLng = parseFloat(pt.lng);
                if (!Number.isFinite(ptLat) || !Number.isFinite(ptLng) ||
                    ptLat < -90 || ptLat > 90 || ptLng < -180 || ptLng > 180)
                    return res.json({ success: false, error: 'One or more polygon points have invalid coordinates.' });
                validated.push({ lat: ptLat, lng: ptLng });
            }
            parent.linkedDevices[deviceIdx].geofence = { mode: 'polygon', points: validated };
        } else if (mode === 'none') {
            parent.linkedDevices[deviceIdx].geofence = { mode: null };
        } else {
            return res.json({ success: false, error: 'Invalid mode. Use "radius", "rectangle", "polygon", or "none".' });
        }

        parent.linkedDevices[deviceIdx].geofenceState = null; // Reset state on geofence change
        await parent.save();
        res.json({ success: true });
    } catch (err) {
        console.error('[Parent] Set geofence error:', err);
        res.json({ success: false, error: 'Server error.' });
    }
});

// ─── NOTIFICATIONS ────────────────────────────────────────────────────────────

// POST /parent/acknowledge
// Marks a specific alert as acknowledged.
router.post('/acknowledge', async (req, res) => {
    try {
        const { notifId } = req.body;
        await Notification.updateOne(
            { _id: notifId, parentUsername: req.session.user.username },
            { acknowledged: true }
        );
        res.redirect('/');
    } catch (err) {
        console.error('[Parent] Acknowledge error:', err);
        res.status(500).send('Server error.');
    }
});

// ─── LOCATION HISTORY API ─────────────────────────────────────────────────────

// GET /parent/history/:childId
// Returns last 100 location records for a child that belongs to this parent.
router.get('/history/:childId', async (req, res) => {
    try {
        const { childId } = req.params;

        // Verify ownership before returning data
        const parent = await User.findOne({
            username: req.session.user.username,
            'linkedDevices.childId': childId
        });
        if (!parent) return res.status(403).json({ error: 'Access denied.' });

        // REDUNDANCY: DB replication — falls back to backup_history if primary fails
        const history = await dbService.readHistoryWithFallback(childId, 100);
        res.json(history);
    } catch (err) {
        console.error('[Parent] History error:', err);
        res.status(500).json({ error: 'Server error.' });
    }
});

module.exports = router;
