// models/Notification.js
const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
    // FIX: OFFLINE type added for heartbeat-generated device-offline alerts
    type:           { type: String, enum: ['GEOFENCE', 'SOS', 'OFFLINE'], required: true },
    childId:        { type: String, required: true },
    childName:      { type: String },
    parentUsername: { type: String, required: true }, // Direct binding to a parent
    msg:            { type: String, required: true },
    isSafe:         { type: Boolean },                // GEOFENCE only: true=entered, false=exited
    acknowledged:   { type: Boolean, default: false },
    // FIX: delivery status tracking — 'pending', 'websocket', 'fallback-log'
    deliveryStatus: { type: String, enum: ['pending', 'websocket', 'fallback-log'], default: 'pending' },
    time:           { type: Date, default: Date.now, index: true }
});

module.exports = mongoose.model('Notification', notificationSchema);
