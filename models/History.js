// models/History.js
const mongoose = require('mongoose');

const historySchema = new mongoose.Schema({
    childId:  { type: String, required: true, index: true },
    location: {
        lat:  { type: Number, required: true },
        lng:  { type: Number, required: true },
        batt: { type: Number, default: 100 }
    },
    time: { type: Date, default: Date.now, index: true }
});

module.exports = mongoose.model('History', historySchema);
