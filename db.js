// file: db.js
const mongoose = require('mongoose');

// Kết nối tới MongoDB (Dùng Localhost cho nhẹ, hoặc ông thay bằng link MongoDB Atlas Cloud đều được)
mongoose.connect('mongodb://127.0.0.1:27017/clms_database')
  .then(() => console.log('🟢 [MongoDB] Đã kết nối Database thành công!'))
  .catch(err => console.log('🔴 [MongoDB] Lỗi kết nối:', err));

// 1. CẤU TRÚC VÙNG AN TOÀN & LIÊN KẾT TRẺ
const safeZoneSchema = new mongoose.Schema({
    id: String,
    name: String,
    type: String, // 'circle' hoặc 'polygon'
    lat: Number, lng: Number, radius: Number, // Cho hình tròn
    coords: [{ lat: Number, lng: Number }]    // Cho đa giác
});

const linkedChildSchema = new mongoose.Schema({
    childUsername: String,
    childName: String,
    safeZones: [safeZoneSchema]
});

// 2. BẢNG USERS (Chứa cả Admin, Parent, Child)
const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    name: String,
    role: { type: String, enum: ['admin', 'parent', 'child'], required: true },
    email: String,
    phone: String,
    linkedChildren: [linkedChildSchema]
});

// 3. BẢNG LỊCH SỬ DI CHUYỂN
const historySchema = new mongoose.Schema({
    child: String,
    location: { lat: Number, lng: Number, batt: Number },
    time: { type: Date, default: Date.now }
});

// 4. BẢNG THÔNG BÁO / CẢNH BÁO
const notificationSchema = new mongoose.Schema({
    id: String,
    type: String, // 'GEOFENCE', 'SOS', 'Request'
    childUsername: String,
    name: String,
    msg: String,
    isSafe: Boolean,
    status: String,
    time: { type: Date, default: Date.now }
});

// Xuất các Model ra để server.js sử dụng
module.exports = {
    User: mongoose.model('User', userSchema),
    History: mongoose.model('History', historySchema),
    Notification: mongoose.model('Notification', notificationSchema)
};