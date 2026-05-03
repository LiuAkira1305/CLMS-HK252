// models/User.js
const mongoose = require('mongoose');

// A child device linked to a parent.
// Children are NOT user accounts — they are IoT device registrations.
const childDeviceSchema = new mongoose.Schema({
    childId:      { type: String, required: true },  // Unique device ID (MQTT topic suffix)
    childName:    { type: String, required: true },   // Display name
    // device auth — pre-shared secret for /iot/sos authentication
    deviceSecret: { type: String, default: null },
    // state persistence — replaces in-memory previousStatus; survives restarts
    geofenceState: { type: Boolean, default: null },  // null=unknown, true=inside, false=outside
    // heartbeat — timestamp of last received GPS ping
    lastSeen:     { type: Date, default: null },
    // offline alert persistence — prevents duplicate OFFLINE alerts after restart
    offlineAlertActive: { type: Boolean, default: false },
    offlineAlertAt:     { type: Date, default: null },
    geofence: {
        mode:   { type: String, enum: ['radius', 'rectangle', 'polygon', null], default: null },
        // Radius mode: centre lat/lng + fixed 1km radius
        lat:    Number,
        lng:    Number,
        // Rectangle mode: two opposite corner coordinates
        north:  Number,
        south:  Number,
        east:   Number,
        west:   Number,
        // Polygon mode: ordered array of vertices [{lat, lng}, ...]
        points: [{ lat: Number, lng: Number, _id: false }]
    }
}, { _id: false });

const userSchema = new mongoose.Schema({
    username:      { type: String, required: true, unique: true, trim: true },
    passwordHash:  { type: String, required: true },
    name:          { type: String, required: true },
    role:          { type: String, enum: ['admin', 'parent'], required: true },
    email:         { type: String },
    phone:         { type: String },
    linkedDevices: { type: [childDeviceSchema], default: [] }
}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);



