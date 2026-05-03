// db.js — Database connection only. Schemas live in /models/.
const mongoose = require('mongoose');

const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/clms_database';
if (!process.env.MONGODB_URI) {
    console.warn('[MongoDB] MONGODB_URI is not set. Using the local development URI.');
}

mongoose.connect(mongoUri)
    .then(() => console.log('🟢 [MongoDB] Connected successfully.'))
    .catch(err => console.error('🔴 [MongoDB] Connection error:', err));

module.exports = mongoose;
