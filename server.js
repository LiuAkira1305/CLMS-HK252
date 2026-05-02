const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const mqtt = require('mqtt');
const { User, History, Notification } = require('./db.js');

// ==========================================
// 1. KHỞI TẠO SERVER & CẤU HÌNH CƠ BẢN
// ==========================================
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = 3000;

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(session({
    secret: 'ase_hcmut_clms_group3_final',
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 3600000 }
}));

const USERS_FILE = path.join(__dirname, 'users.json');
const NOTIFICATIONS_FILE = path.join(__dirname, 'notifications.json');
const HISTORY_FILE = path.join(__dirname, 'history.json');

// Tạo file nếu chưa tồn tại
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, JSON.stringify([]));
if (!fs.existsSync(NOTIFICATIONS_FILE)) fs.writeFileSync(NOTIFICATIONS_FILE, JSON.stringify([]));
if (!fs.existsSync(HISTORY_FILE)) fs.writeFileSync(HISTORY_FILE, JSON.stringify([]));

// Hàm đọc/ghi file
// function getData(file) { return JSON.parse(fs.readFileSync(file)); }
// function saveData(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }

// ==========================================
// 2. THUẬT TOÁN GEOFENCING (HAVERSINE)
// ==========================================
function isInsideCircle(point, circle) {
    const R = 6371e3;
    const lat1 = point.lat * Math.PI / 180;
    const lat2 = circle.lat * Math.PI / 180;
    const deltaLat = (circle.lat - point.lat) * Math.PI / 180;
    const deltaLng = (circle.lng - point.lng) * Math.PI / 180;

    const a = Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
        Math.cos(lat1) * Math.cos(lat2) *
        Math.sin(deltaLng / 2) * Math.sin(deltaLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return (R * c) <= circle.radius;
}

function isInsidePolygon(point, polygon) {
    let x = point.lat, y = point.lng;
    let isInside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        let xi = polygon[i].lat, yi = polygon[i].lng;
        let xj = polygon[j].lat, yj = polygon[j].lng;
        let intersect = ((yi > y) != (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
        if (intersect) isInside = !isInside;
    }
    return isInside;
}

// ==========================================
// 3. KẾT NỐI MQTT (HIVEMQ CLOUD)
// ==========================================
const previousStatus = {};
const mqttClient = mqtt.connect('mqtts://eea6ea368a3b45f59f40963f1e2dcf47.s1.eu.hivemq.cloud:8883', {
    username: 'liu_apple',
    password: '@@Dominhhien1305' // <--- ĐIỀN MẬT KHẨU CỦA BẠN VÀO ĐÂY
});

mqttClient.on('connect', () => {
    console.log('📡 [MQTT] Đã kết nối với HiveMQ Cloud!');
    mqttClient.subscribe('clmshk252group3/clms/#', (err) => {
        if (err) console.log('❌ Lỗi Subscribe:', err);
        else console.log('✅ Đã đăng ký lắng nghe kênh GPS thành công!');
    });
});

mqttClient.on('message', async (topic, message) => {
    try {
        let childUsername = topic.split('/').pop();
        const data = JSON.parse(message.toString());

        // --- HỆ THỐNG AUTO-FALLBACK: SỬA LỖI OWNTRACKS GỬI SAI TÊN ---
        if (childUsername === 'clms' || childUsername === 'undefined' || !childUsername) {
            const parentWithChild = await User.findOne({ role: 'parent', 'linkedChildren.0': { $exists: true } });
            if (parentWithChild) {
                childUsername = parentWithChild.linkedChildren[0].childUsername; 
                console.log(`🛠 [HOTFIX] Đã tự động nắn lại định danh: ${childUsername}`);
            }
        }

        if (data._type === 'location' || (data.lat && data.lon)) {
            console.log(`[GPS] Nhận từ ${childUsername}: ${data.lat}, ${data.lon}`);
            io.emit('force-map-update', { lat: data.lat, lng: data.lon });
            const currentLocation = { lat: data.lat, lng: data.lon, batt: data.batt || 100 };

            // 💾 MONGODB: Lưu lịch sử tọa độ
            await History.create({ child: childUsername, location: currentLocation });

            // 💾 MONGODB: Lấy danh sách phụ huynh để check Geofence
            const parents = await User.find({ role: 'parent' });

            parents.forEach(async (parent) => {
                const childRecord = parent.linkedChildren.find(c => c.childUsername === childUsername);
                if (childRecord) {
                    let insideAnyZone = false;
                    if (childRecord.safeZones && childRecord.safeZones.length > 0) {
                        for (let zone of childRecord.safeZones) {
                            if (zone.type === 'circle' && isInsideCircle(currentLocation, zone)) insideAnyZone = true;
                            if (zone.type === 'polygon' && isInsidePolygon(currentLocation, zone.coords)) insideAnyZone = true;
                        }
                    } else {
                        insideAnyZone = true; 
                    }

                    const lastSafe = previousStatus[childUsername];
                    const isFirstPingAndOutside = (lastSafe === undefined && !insideAnyZone);
                    const isStateChanged = (lastSafe !== undefined && lastSafe !== insideAnyZone);

                    if (isFirstPingAndOutside || isStateChanged) {
                        const alertMsg = insideAnyZone ? `Trẻ vừa đi VÀO vùng an toàn.` : `CẢNH BÁO: Trẻ vừa đi RA KHỎI vùng an toàn!`;
                        
                        const newAlert = {
                            id: Date.now().toString(),
                            type: 'GEOFENCE',
                            childUsername: childUsername,
                            name: childRecord.childName,
                            isSafe: insideAnyZone,
                            msg: alertMsg
                        };
                        
                        // 💾 MONGODB: Lưu cảnh báo
                        await Notification.create(newAlert);
                        io.emit('geofence-alert', { ...newAlert, time: new Date().toLocaleString() });
                    }
                    
                    previousStatus[childUsername] = insideAnyZone; 
                    io.emit(`gps-update-${parent.username}`, { childUsername, location: currentLocation, isSafe: insideAnyZone });
                }
            });
        }
    } catch (e) {
        console.log('[MQTT] Lỗi phân tích dữ liệu:', e.message);
    }
});

// ==========================================
// 4. ROUTES XÁC THỰC (AUTH) - ĐÃ LÊN MONGODB
// ==========================================
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'views', 'login.html')));

// Thêm async vào đây
app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    
    // 💾 MONGODB: Tìm user có khớp username và password không
    const user = await User.findOne({ username: username, password: password });
    
    if (user) { 
        // Lưu session (chỉ lưu những thông tin cần thiết cho nhẹ)
        req.session.user = { username: user.username, role: user.role, name: user.name }; 
        res.redirect('/'); 
    }
    else res.send('<script>alert("Sai tài khoản hoặc mật khẩu!"); window.location="/login";</script>');
});

app.get('/register', (req, res) => res.sendFile(path.join(__dirname, 'views', 'register.html')));

// Thêm async vào đây
app.post('/register', async (req, res) => {
    const { username, name, role, email, phone, password, confirmPassword } = req.body;
    
    if (role === 'admin') return res.status(403).send('Chặn đăng ký Admin.');
    if (password !== confirmPassword) return res.send('Mật khẩu không khớp!');
    
    // 💾 MONGODB: Kiểm tra xem username đã có ai lấy chưa
    const existingUser = await User.findOne({ username: username });
    if (existingUser) return res.send('Username đã tồn tại!');
    
    // 💾 MONGODB: Tạo và lưu user mới tinh vào Database
    await User.create({ 
        username, name, role, email, phone, password, linkedChildren: [] 
    });
    
    res.send('<script>alert("Đăng ký thành công!"); window.location="/login";</script>');
});

app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });

// ==========================================
// 5. API NGHIỆP VỤ (HÀNH ĐỘNG CỦA CÁC ROLE) - LÊN MONGODB
// ==========================================
app.post('/admin/delete-user', async (req, res) => {
    if (req.session.user?.role !== 'admin') return res.status(403).send('Từ chối truy cập.');
    
    // Xóa user bị chọn
    await User.deleteOne({ username: req.body.targetUsername });
    // Quét tất cả phụ huynh, ai đang liên kết với đứa trẻ vừa bị xóa thì gỡ liên kết luôn
    await User.updateMany(
        { role: 'parent' },
        { $pull: { linkedChildren: { childUsername: req.body.targetUsername } } }
    );
    res.redirect('/');
});

app.post('/admin/link-pair', async (req, res) => {
    if (req.session.user?.role !== 'admin') return res.status(403).send('Từ chối truy cập.');
    const { parentUser, childUser } = req.body;
    
    const parent = await User.findOne({ username: parentUser, role: 'parent' });
    const child = await User.findOne({ username: childUser, role: 'child' });
    
    if (parent && child && !parent.linkedChildren.find(c => c.childUsername === child.username)) {
        parent.linkedChildren.push({ childUsername: child.username, childName: child.name, safeZones: [] });
        await parent.save(); // Lưu vào MongoDB
    }
    res.redirect('/');
});

app.post('/parent/add-child', async (req, res) => {
    if (req.session.user?.role !== 'parent') return res.status(403).send('Từ chối truy cập.');
    const { childUsername } = req.body;
    
    const child = await User.findOne({ username: childUsername, role: 'child' });
    if (!child) return res.send('<script>alert("Không tìm thấy tài khoản trẻ em này!"); window.location="/";</script>');

    const parent = await User.findOne({ username: req.session.user.username });
    if (parent.linkedChildren.find(c => c.childUsername === childUsername)) return res.redirect('/');

    parent.linkedChildren.push({
        childUsername: child.username,
        childName: child.name,
        safeZones: []
    });
    await parent.save();
    res.redirect('/');
});

app.post('/parent/remove-child', async (req, res) => {
    if (req.session.user?.role !== 'parent') return res.status(403).send('Từ chối truy cập.');
    
    await User.updateOne(
        { username: req.session.user.username },
        { $pull: { linkedChildren: { childUsername: req.body.childUsername } } }
    );
    res.redirect('/');
});

// ==========================================
// API: Lưu vùng vẽ mới (Đã lên MongoDB)
// ==========================================
app.post('/parent/save-zone', async (req, res) => {
    try {
        const { childUsername, zoneData } = req.body;

        // 💾 MONGODB: Tìm chính xác user phụ huynh đang đăng nhập
        const parent = await User.findOne({ username: req.session.user.username });
        if (!parent) return res.json({ success: false });

        // Tìm vị trí của đứa trẻ trong mảng linkedChildren
        const cIdx = parent.linkedChildren.findIndex(c => c.childUsername === childUsername);

        if (cIdx !== -1) {
            // Mongoose đã tự động chuẩn bị sẵn mảng safeZones (dựa theo Schema)
            zoneData.id = Date.now().toString(); // Tạo ID ngẫu nhiên
            
            // Push thẳng vùng mới vào con
            parent.linkedChildren[cIdx].safeZones.push(zoneData);
            
            // 💾 MONGODB: Ra lệnh lưu lại những thay đổi vừa nãy vào Database
            await parent.save();
            
            // Không cần cập nhật lại session ở đây vì session chỉ giữ username/role là đủ
            res.json({ success: true });
        } else {
            res.json({ success: false });
        }
    } catch (error) {
        console.log("❌ Lỗi lúc Lưu Vùng DB:", error);
        res.json({ success: false });
    }
});

// ==========================================
// API: Xóa 1 vùng cụ thể (Bản MongoDB)
// ==========================================

app.post('/parent/delete-zone', async (req, res) => {
    try {
        const { childUsername, zoneId } = req.body;

        // 💾 MONGODB: Tìm parent hiện tại
        const parent = await User.findOne({ username: req.session.user.username });
        if (!parent) return res.json({ success: false });

        const cIdx = parent.linkedChildren.findIndex(c => c.childUsername === childUsername);

        if (cIdx !== -1 && parent.linkedChildren[cIdx].safeZones) {
            // Lọc bỏ vùng có id trùng khớp
            parent.linkedChildren[cIdx].safeZones = parent.linkedChildren[cIdx].safeZones.filter(z => z.id !== zoneId);
            
            // 💾 MONGODB: Lưu lại thay đổi
            await parent.save();
            res.json({ success: true });
        } else {
            res.json({ success: false });
        }
    } catch (error) {
        console.log("❌ Lỗi lúc Xóa Vùng:", error);
        res.json({ success: false });
    }
});

app.post('/parent/set-geofence', async (req, res) => {
    if (req.session.user?.role !== 'parent') return res.status(403).send('Từ chối truy cập.');
    const { childUsername, radius } = req.body;
    
    // 💾 MONGODB: Tìm parent và cập nhật
    const parent = await User.findOne({ username: req.session.user.username });
    if (parent) {
        const cIdx = parent.linkedChildren.findIndex(c => c.childUsername === childUsername);
        if (cIdx !== -1 && parent.linkedChildren[cIdx].safeZone) {
            parent.linkedChildren[cIdx].safeZone.radius = parseInt(radius);
            await parent.save();
        }
    }
    res.redirect('/');
});

app.post('/parent/respond-request', async (req, res) => {
    if (req.session.user?.role !== 'parent') return res.status(403).send('Từ chối truy cập.');
    
    // 💾 MONGODB: Tìm đúng Notification theo ID và cập nhật status luôn, không cần load hết
    await Notification.updateOne(
        { id: req.body.requestId }, 
        { status: req.body.status }
    );
    
    res.redirect('/');
});

app.post('/child/sos', async (req, res) => {
    if (req.session.user?.role !== 'child') return res.status(403).send('Từ chối truy cập.');
    
    // 💾 MONGODB: Tạo mới một bản ghi Cảnh báo (SOS)
    await Notification.create({ 
        id: Date.now().toString(), 
        type: 'SOS', 
        childUsername: req.session.user.username, 
        name: req.session.user.name, 
        status: 'Critical', 
        msg: 'Tín hiệu SOS KHẨN CẤP!' 
    });
    
    res.redirect('/');
});

app.post('/child/request-move', async (req, res) => {
    if (req.session.user?.role !== 'child') return res.status(403).send('Từ chối truy cập.');
    
    // 💾 MONGODB: Tạo mới một bản ghi Yêu cầu di chuyển
    await Notification.create({ 
        id: Date.now().toString(), 
        type: 'Request', 
        childUsername: req.session.user.username, 
        name: req.session.user.name, 
        msg: req.body.destination, // Lưu vào trường msg theo schema db.js
        status: 'Pending' 
    });
    
    res.redirect('/');
});

// ==========================================
// 6. DASHBOARD CHÍNH (GIAO DIỆN WEB)
// ==========================================
app.get('/', async (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    
    // 💾 MONGODB: Kéo dữ liệu tươi nhất từ Database lên Web
    const user = await User.findOne({ username: req.session.user.username });
    const users = await User.find();
    const notifications = await Notification.find().sort({ time: -1 });

    let html = `
    <!DOCTYPE html>
    <html lang="vi">
    <head>
        <meta charset="UTF-8">
        <title>CLMS Dashboard</title>
        <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
        <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
        <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/leaflet.draw/1.0.4/leaflet.draw.css" />
        <script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet.draw/1.0.4/leaflet.draw.js"></script>
        <script src="/socket.io/socket.io.js"></script>
        <style>
            body { font-family: sans-serif; margin: 0; display: flex; height: 100vh; background: #f4f7f6; }
            .sidebar { width: 250px; background: #2c3e50; color: white; padding: 20px; display: flex; flex-direction: column; }
            .main { flex-grow: 1; padding: 30px; overflow-y: auto; }
            .card { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 5px rgba(0,0,0,0.1); margin-bottom: 20px; }
            table { width: 100%; border-collapse: collapse; margin-top: 10px; }
            th, td { text-align: left; padding: 10px; border-bottom: 1px solid #eee; }
            .btn { background: #8b3fa0; color: white; border: none; padding: 8px 15px; border-radius: 4px; cursor: pointer; }
            .btn-danger { background: #e74c3c; }
            .btn-success { background: #27ae60; }
            .input-box { padding: 8px; border: 1px solid #ccc; border-radius: 4px; }
            #map { height: 450px; width: 100%; border-radius: 8px; z-index: 1; }
            .status-safe { color: green; font-weight: bold; }
            .status-danger { color: red; font-weight: bold; }
            .sos-btn { background: #e74c3c; color: white; border:none; padding:30px; border-radius:50%; width:150px; height:150px; font-size:24px; font-weight:bold; cursor:pointer; margin:auto; display:block; }
        </style>
    </head>
    <body>
        <div class="sidebar">
            <h2 style="text-align:center; border-bottom: 1px solid #444; padding-bottom: 15px;">CLMS Group 3</h2>
            <div style="flex-grow: 1;">
                <p>Chào, <strong>${user.name}</strong><br><small>Vai trò: ${user.role}</small></p>
            </div>
            <a href="/logout" style="color:#ff7675; text-decoration:none; text-align:center;">🚪 Đăng xuất</a>
        </div>
        <div class="main">
    `;

    // --- GIAO DIỆN ADMIN ---
    if (user.role === 'admin') {
        html += `
            <div class="card">
                <h2>Bảng Quản Trị (Admin)</h2>
                <h3>👥 Quản lý Người dùng & Xóa</h3>
                <table>
                    <tr><th>Username</th><th>Họ tên</th><th>Role</th><th>Hành động</th></tr>
                    ${users.filter(u => u.role !== 'admin').map(u => `
                        <tr>
                            <td>${u.username}</td><td>${u.name}</td><td>${u.role}</td>
                            <td>
                                <form action="/admin/delete-user" method="POST" style="margin:0;">
                                    <input type="hidden" name="targetUsername" value="${u.username}">
                                    <button type="submit" class="btn btn-danger">Xóa</button>
                                </form>
                            </td>
                        </tr>
                    `).join('')}
                </table>
            </div>
            <div class="card">
                <h3>🔗 Công cụ Nối cặp (Manual Pairing)</h3>
                <form action="/admin/link-pair" method="POST" style="display: flex; gap: 10px; align-items: center;">
                    <select name="parentUser" class="input-box" required><option value="">-- Phụ huynh --</option>${users.filter(u => u.role === 'parent').map(u => `<option value="${u.username}">${u.name}</option>`).join('')}</select>
                    <span>liên kết với</span>
                    <select name="childUser" class="input-box" required><option value="">-- Trẻ em --</option>${users.filter(u => u.role === 'child').map(u => `<option value="${u.username}">${u.name}</option>`).join('')}</select>
                    <button type="submit" class="btn btn-success">Xác nhận Liên kết</button>
                </form>
            </div>
        `;
    }
    // --- GIAO DIỆN PARENT ---
    else if (user.role === 'parent') {
        html += `
            ${notifications.filter(n => n.type === 'SOS' && n.status === 'Critical').length > 0 ? `
                <div class="card" style="background: #fdf2f2; border-left: 5px solid red;">
                    <h3 style="color: red; margin:0;">🚨 CẢNH BÁO SOS KHẨN CẤP</h3>
                    ${notifications.filter(n => n.type === 'SOS' && n.status === 'Critical').map(n => `<p>${n.msg} từ ${n.name} (${n.time})</p>`).join('')}
                </div>
            ` : ''}

            <div class="card">
                <h2>📍 Bản đồ (Live Tracking)</h2>
                <div id="map"></div>
                <p id="status-bar" style="margin-top: 10px; font-size: 14px; font-weight: bold; color: green;">🟢 Đang chờ tín hiệu từ điện thoại...</p>
            </div>

            <div class="card">
                <h3>🔔 Lịch sử Cảnh báo Ra/Vào vùng an toàn</h3>
                <div id="alert-list" style="max-height: 250px; overflow-y: auto; background: #fff9f9; padding: 10px; border-radius: 5px; border: 1px solid #fee;">
                    ${notifications.filter(n => n.type === 'GEOFENCE').reverse().map(n => `
                        <div style="padding: 10px; border-bottom: 1px solid #eee; color: ${n.isSafe ? '#27ae60' : '#e74c3c'};">
                            <strong>${n.isSafe ? '🟢 IN' : '🔴 OUT'}:</strong> ${n.msg} (Bé ${n.name}) <br>
                            <small style="color:gray;">🕒 ${n.time}</small>
                        </div>
                    `).join('') || '<p style="color:gray; text-align:center;">Chưa có cảnh báo nào.</p>'}
                </div>
            </div>

            <div class="card" style="display:flex; gap: 20px;">
                <div style="flex:2;">
                    <h3>👦👧 Trẻ đang giám sát</h3>
                    <table>
                        <tr><th>Tên Trẻ</th><th>Hành động</th></tr>
                        ${user.linkedChildren.map(c => `
                            <tr>
                                <td>${c.childName} <br><small>(@${c.childUsername})</small></td>
                                <td>
                                    <form action="/parent/remove-child" method="POST" style="display:inline-block;">
                                        <input type="hidden" name="childUsername" value="${c.childUsername}">
                                        <button type="submit" class="btn btn-danger">Hủy LK</button>
                                    </form>
                                </td>
                            </tr>
                        `).join('')}
                    </table>
                </div>
                <div style="flex:1;">
                    <h3>➕ Thêm liên kết</h3>
                    <form action="/parent/add-child" method="POST">
                        <input type="text" name="childUsername" class="input-box" style="width:100%; margin-bottom:10px;" placeholder="Username của trẻ" required>
                        <button type="submit" class="btn" style="width:100%;">Tạo Liên Kết</button>
                    </form>
                    
                    <h3 style="margin-top:20px;">🔔 Yêu cầu di chuyển</h3>
                    ${notifications.filter(n => n.type === 'Request' && n.status === 'Pending').map(n => `
                        <div style="padding-bottom:10px; border-bottom:1px solid #eee; margin-top:10px;">
                            Bé <strong>${n.name}</strong> xin đi: <em>${n.destination}</em>
                            <form action="/parent/respond-request" method="POST" style="margin-top:5px; display:flex; gap:5px;">
                                <input type="hidden" name="requestId" value="${n.id}">
                                <button name="status" value="Approved" class="btn btn-success" style="flex:1; padding: 5px;">Đồng ý</button>
                                <button name="status" value="Denied" class="btn btn-danger" style="flex:1; padding: 5px;">Từ chối</button>
                            </form>
                        </div>
                    `).join('') || '<p style="font-size:13px; color:gray;">Không có yêu cầu nào.</p>'}
                </div>
            </div>

            <script>
                // 1. Khởi tạo bản đồ mặc định
                var map = L.map('map').setView([10.7723, 106.6581], 15);
                L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(map);
                
                // --- BẮT ĐẦU PHẦN CÔNG CỤ VẼ ---
                var drawnItems = new L.FeatureGroup();
                map.addLayer(drawnItems);

                    // Bật thanh công cụ vẽ
                    var drawControl = new L.Control.Draw({
                        edit: { featureGroup: drawnItems, remove: false }, // Mình tự làm nút xóa riêng
                        draw: {
                            polygon: true,
                            circle: true,
                            rectangle: false, polyline: false, marker: false, circlemarker: false
                        }
                    });
                    map.addControl(drawControl);

                // Lấy dữ liệu trẻ em từ EJS/Template literal
                const childrenData = ${JSON.stringify(user.linkedChildren)};

                // 1. Vẽ các vùng an toàn đã lưu lên bản đồ
                childrenData.forEach(c => {
                    if(c.safeZones) {
                        c.safeZones.forEach(z => {
                            let layer;
                            if(z.type === 'circle') layer = L.circle([z.lat, z.lng], { radius: z.radius, color: 'purple' });
                            else if (z.type === 'polygon') layer = L.polygon(z.coords, { color: 'green' });
                            
                            if (layer) {
                                // Tạo Popup có nút XÓA ngay trên bản đồ
                                let popupContent = \`<b>\${z.name}</b> <br> 
                                <button onclick="deleteZone('\${c.childUsername}', '\${z.id}')" style="margin-top:5px; background:red; color:white; border:none; padding:5px; cursor:pointer;">Xóa vùng này</button>\`;
                                layer.bindPopup(popupContent);
                                drawnItems.addLayer(layer);
                            }
                        });
                    }
                });

                // 2. Xử lý khi người dùng VẼ XONG
                map.on(L.Draw.Event.CREATED, function (event) {
                    var layer = event.layer;
                    var type = event.layerType;

                    // Chọn trẻ đầu tiên để gán vùng (nếu ông có nhiều trẻ thì sẽ cần UI chọn, tạm thời gán cho bé đầu tiên)
                    var targetChild = childrenData[0]; 
                    if(!targetChild) { alert("Cần kết nối trẻ em trước khi vẽ!"); return; }

                    var zoneName = prompt("Nhập tên cho Vùng an toàn này (VD: Sân banh, Nhà ngoại):");
                    if (!zoneName) return; 

                    var zoneData = { name: zoneName, type: type };
                    if (type === 'circle') {
                        zoneData.lat = layer.getLatLng().lat;
                        zoneData.lng = layer.getLatLng().lng;
                        zoneData.radius = layer.getRadius();
                    } else if (type === 'polygon') {
                        zoneData.coords = layer.getLatLngs()[0].map(pt => ({ lat: pt.lat, lng: pt.lng }));
                    }

                    // Bắn API lưu
                    fetch('/parent/save-zone', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ childUsername: targetChild.childUsername, zoneData: zoneData })
                    }).then(res => res.json()).then(data => {
                        if(data.success) window.location.reload(); 
                    });
                });

                // 3. Hàm gọi API xóa vùng
                window.deleteZone = function(childUsername, zoneId) {
                    if(confirm("Xóa vùng an toàn này?")) {
                        fetch('/parent/delete-zone', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ childUsername, zoneId })
                        }).then(res => res.json()).then(data => {
                            if(data.success) window.location.reload();
                        });
                    }
                }
                // --- KẾT THÚC PHẦN CÔNG CỤ VẼ ---

                // 2. Biến duy nhất để chứa cái cọc định vị (Marker)
                var liveMarker; 

                // 3. Khởi tạo Socket.io lắng nghe sự kiện
                const socket = io();
                
                console.log("🖥️ Chế độ TEST XUYÊN THỦNG đã bật. Đang chờ tọa độ...");

                // 4. Lắng nghe KÊNH PHÁT SÓNG TOÀN CẦU (Bỏ qua username)
                socket.on('force-map-update', function(data) {
                    console.log("🔥 [BẮT ĐƯỢC DATA TRÊN WEB] Tọa độ:", data);
                    
                    const viTriMoi = [data.lat, data.lng];
                    
                    // Cập nhật thanh trạng thái cho xôm tụ
                    const bar = document.getElementById('status-bar');
                    if(bar) {
                        bar.innerHTML = "📡 Đã định vị trẻ thành công tại tọa độ: " + data.lat + ", " + data.lng;
                        bar.style.color = "blue";
                    }

                    // Nếu chưa có cọc thì tạo mới, có rồi thì dời đi
                    if (!liveMarker) {
                        liveMarker = L.marker(viTriMoi).addTo(map).bindPopup("<b>📍 Trẻ đang ở đây!</b>").openPopup();
                    } else {
                        liveMarker.setLatLng(viTriMoi);
                    }

                    // Tự động kéo bản đồ bay về vị trí mới
                    map.setView(viTriMoi, 17);
                });

                // Nghe chuông báo động Geofence
                socket.on('geofence-alert', function(data) {
                    // Nhảy Pop-up trình duyệt cho phụ huynh giật mình
                    if (!data.isSafe) {
                        alert("🚨 GEOFENCE ALERT: " + data.msg + " (Bé: " + data.name + ")");
                    } else {
                        alert("🟢 THÔNG BÁO: " + data.msg + " (Bé: " + data.name + ")");
                    }

                    // Chèn thông báo mới toanh lên trên cùng của danh sách
                    const alertList = document.getElementById('alert-list');
                    if(alertList && alertList.innerHTML.includes('Chưa có cảnh báo nào')) alertList.innerHTML = '';
                        
                    const newDiv = document.createElement('div');
                    newDiv.style = "padding: 10px; border-bottom: 1px solid #eee; color: " + (data.isSafe ? "#27ae60" : "#e74c3c") + ";";
                    newDiv.innerHTML = "<strong>" + (data.isSafe ? "🟢 IN" : "🔴 OUT") + ":</strong> " + data.msg + " (Bé " + data.name + ") <br><small style='color:gray;'>🕒 " + data.time + "</small>";
                        
                    if(alertList) alertList.insertBefore(newDiv, alertList.firstChild);
                });
            </script>
        `;
    }
    // --- GIAO DIỆN CHILD ---
    else if (user.role === 'child') {
        html += `
            <div class="card" style="text-align:center; padding: 40px;">
                <h2 style="color: #333;">TRUNG TÂM KHẨN CẤP</h2>
                <form action="/child/sos" method="POST">
                    <button type="submit" class="sos-btn">SOS</button>
                </form>
                <p style="color:#e74c3c; font-size:14px; margin-top:20px; font-weight:bold;">Chỉ nhấn khi thực sự gặp nguy hiểm!</p>
            </div>
            <div style="display: flex; gap: 20px;">
                <div class="card" style="flex: 1;">
                    <h3>🙋 Xin phép di chuyển</h3>
                    <form action="/child/request-move" method="POST">
                        <input type="text" name="destination" class="input-box" style="width:100%; margin-bottom:10px; box-sizing:border-box;" placeholder="Con muốn đi đâu?" required>
                        <button type="submit" class="btn" style="width:100%;">Gửi yêu cầu cho ba mẹ</button>
                    </form>
                </div>
                <div class="card" style="flex: 1;">
                    <h3>📬 Thông báo từ ba mẹ</h3>
                    ${notifications.filter(n => n.from === user.username && n.type === 'Request').reverse().map(n => `
                        <div style="padding:10px; border-bottom:1px solid #eee; display: flex; justify-content: space-between;">
                            <span>Xin đi: <strong>${n.destination}</strong></span>
                            <span style="font-weight:bold; color:${n.status === 'Approved' ? '#27ae60' : (n.status === 'Denied' ? '#e74c3c' : '#f39c12')}">
                                ${n.status === 'Pending' ? 'Đang chờ' : (n.status === 'Approved' ? 'Đã cho phép' : 'Bị từ chối')}
                            </span>
                        </div>
                    `).join('') || '<p style="color:gray;">Chưa có thông báo nào.</p>'}
                </div>
            </div>
        `;
    }

    html += `</div></body></html>`;
    res.send(html);
});

server.listen(PORT, () => console.log(`🚀 CLMS Real-time Server Running on: http://localhost:${PORT}`));