// db.js — Database connection only. Schemas live in /models/.
const mongoose = require('mongoose');

mongoose.connect('mongodb://127.0.0.1:27017/clms_database')
    .then(() => console.log('🟢 [MongoDB] Connected successfully.'))
    .catch(err => console.error('🔴 [MongoDB] Connection error:', err));

module.exports = mongoose;