const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const mqtt = require('mqtt');

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
function getData(file) { return JSON.parse(fs.readFileSync(file)); }
function saveData(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }

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

mqttClient.on('message', (topic, message) => {
    try {
        let childUsername = topic.split('/').pop();
        const data = JSON.parse(message.toString());

        // --- HỆ THỐNG AUTO-FALLBACK: SỬA LỖI OWNTRACKS GỬI SAI TÊN ---
        if (childUsername === 'clms' || childUsername === 'undefined' || !childUsername) {
            const allUsers = getData(USERS_FILE);
            // Lục tìm phụ huynh nào đang có trẻ để gán ép tọa độ vào trẻ đó
            const parentWithChild = allUsers.find(u => u.role === 'parent' && u.linkedChildren && u.linkedChildren.length > 0);
            if (parentWithChild) {
                childUsername = parentWithChild.linkedChildren[0].childUsername; 
                console.log(`🛠 [HOTFIX] Đã tự động nắn lại định danh từ app thành: ${childUsername}`);
            }
        }

        if (data._type === 'location' || (data.lat && data.lon)) {
            console.log(`[GPS] Nhận từ ${childUsername}: ${data.lat}, ${data.lon}`);
            io.emit('force-map-update', { lat: data.lat, lng: data.lon });
            const currentLocation = { lat: data.lat, lng: data.lon, batt: data.batt || 100 };

            // Lưu lịch sử tọa độ
            const history = getData(HISTORY_FILE);
            history.push({ child: childUsername, location: currentLocation, time: new Date().toISOString() });
            saveData(HISTORY_FILE, history);

            // Kiểm tra vùng an toàn & Gửi dữ liệu Real-time
            const users = getData(USERS_FILE);
            const notifications = getData(NOTIFICATIONS_FILE);

            users.filter(u => u.role === 'parent').forEach(parent => {
                const childRecord = parent.linkedChildren.find(c => c.childUsername === childUsername);
                if (childRecord) {
                    // 1. KIỂM TRA XEM TRẺ CÓ ĐANG Ở TRONG BẤT KỲ VÙNG NÀO KHÔNG (Cả tròn và đa giác)
                    let insideAnyZone = false;
                    if (childRecord.safeZones && childRecord.safeZones.length > 0) {
                        for (let zone of childRecord.safeZones) {
                            if (zone.type === 'circle' && isInsideCircle(currentLocation, zone)) insideAnyZone = true;
                            if (zone.type === 'polygon' && isInsidePolygon(currentLocation, zone.coords)) insideAnyZone = true;
                        }
                    } else {
                        insideAnyZone = true; // Nếu phụ huynh chưa vẽ vùng nào thì mặc định là không báo độngS
                    }

                    // 2. THUẬT TOÁN BẮT SỰ KIỆN (NÂNG CẤP)
                    const lastSafe = previousStatus[childUsername];
                    
                    // Logic: Báo động nếu CÓ SỰ THAY ĐỔI, HOẶC nếu vừa bật Server lên mà đã thấy trẻ ở NGOÀI VÙNG
                    const isFirstPingAndOutside = (lastSafe === undefined && !insideAnyZone);
                    const isStateChanged = (lastSafe !== undefined && lastSafe !== insideAnyZone);

                    if (isFirstPingAndOutside || isStateChanged) {
                        const alertMsg = insideAnyZone ? `Trẻ vừa đi VÀO vùng an toàn.` : `CẢNH BÁO: Trẻ vừa đi RA KHỎI vùng an toàn!`;
                        
                        const newAlert = {
                            id: Date.now(),
                            type: 'GEOFENCE',
                            childUsername: childUsername,
                            name: childRecord.childName,
                            time: new Date().toLocaleString(),
                            isSafe: insideAnyZone,
                            msg: alertMsg
                        };
                        
                        notifications.push(newAlert);
                        saveData(NOTIFICATIONS_FILE, notifications);

                        // Phát loa báo động khẩn cấp xuống Web
                        io.emit('geofence-alert', newAlert);
                    }
                    
                    // Cập nhật lại bộ nhớ cho lần check sau
                    previousStatus[childUsername] = insideAnyZone; 

                    // Đẩy dữ liệu tọa độ qua Socket.io như bình thường
                    io.emit(`gps-update-${parent.username}`, {
                        childUsername: childUsername,
                        location: currentLocation,
                        isSafe: insideAnyZone
                    });
                }
            });
        }
    } catch (e) {
        console.log('[MQTT] Lỗi phân tích dữ liệu:', e.message);
    }
});

// ==========================================
// 4. ROUTES XÁC THỰC (AUTH)
// ==========================================
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'views', 'login.html')));

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    const user = getData(USERS_FILE).find(u => u.username === username && u.password === password);
    if (user) { req.session.user = user; res.redirect('/'); }
    else res.send('<script>alert("Sai tài khoản hoặc mật khẩu!"); window.location="/login";</script>');
});

app.get('/register', (req, res) => res.sendFile(path.join(__dirname, 'views', 'register.html')));

app.post('/register', (req, res) => {
    const { username, name, role, email, phone, password, confirmPassword } = req.body;
    if (role === 'admin') return res.status(403).send('Chặn đăng ký Admin.');
    if (password !== confirmPassword) return res.send('Mật khẩu không khớp!');
    const users = getData(USERS_FILE);
    if (users.find(u => u.username === username)) return res.send('Username đã tồn tại!');
    users.push({ username, name, role, email, phone, password, linkedChildren: [] });
    saveData(USERS_FILE, users);
    res.send('<script>alert("Đăng ký thành công!"); window.location="/login";</script>');
});

app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });

// ==========================================
// 5. API NGHIỆP VỤ (HÀNH ĐỘNG CỦA CÁC ROLE)
// ==========================================
app.post('/admin/delete-user', (req, res) => {
    if (req.session.user?.role !== 'admin') return res.status(403).send('Từ chối truy cập.');
    let users = getData(USERS_FILE);
    users = users.filter(u => u.username !== req.body.targetUsername);
    users.forEach(u => { if (u.linkedChildren) u.linkedChildren = u.linkedChildren.filter(c => c.childUsername !== req.body.targetUsername); });
    saveData(USERS_FILE, users);
    res.redirect('/');
});

app.post('/admin/link-pair', (req, res) => {
    if (req.session.user?.role !== 'admin') return res.status(403).send('Từ chối truy cập.');
    const { parentUser, childUser } = req.body;
    const users = getData(USERS_FILE);
    const parent = users.find(u => u.username === parentUser && u.role === 'parent');
    const child = users.find(u => u.username === childUser && u.role === 'child');
    if (parent && child && !parent.linkedChildren.find(c => c.childUsername === child.username)) {
        parent.linkedChildren.push({ childUsername: child.username, childName: child.name, safeZone: { lat: 10.7723, lng: 106.6581, radius: 500 } });
        saveData(USERS_FILE, users);
    }
    res.redirect('/');
});

app.post('/parent/add-child', (req, res) => {
    if (req.session.user?.role !== 'parent') return res.status(403).send('Từ chối truy cập.');
    const { childUsername } = req.body;
    const users = getData(USERS_FILE);
    const child = users.find(u => u.username === childUsername && u.role === 'child');
    if (!child) return res.send('<script>alert("Không tìm thấy tài khoản trẻ em này!"); window.location="/";</script>');

    const pIdx = users.findIndex(u => u.username === req.session.user.username);
    if (users[pIdx].linkedChildren.find(c => c.childUsername === childUsername)) return res.redirect('/');

    users[pIdx].linkedChildren.push({
        childUsername: child.username,
        childName: child.name,
        safeZone: { lat: 10.7723, lng: 106.6581, radius: 500 }
    });
    saveData(USERS_FILE, users);
    req.session.user = users[pIdx];
    res.redirect('/');
});

app.post('/parent/remove-child', (req, res) => {
    if (req.session.user?.role !== 'parent') return res.status(403).send('Từ chối truy cập.');
    const users = getData(USERS_FILE);
    const pIdx = users.findIndex(u => u.username === req.session.user.username);
    users[pIdx].linkedChildren = users[pIdx].linkedChildren.filter(c => c.childUsername !== req.body.childUsername);
    saveData(USERS_FILE, users);
    req.session.user = users[pIdx];
    res.redirect('/');
});

// ==========================================
// API: Lưu vùng vẽ mới (Bản Sạch)
// ==========================================
app.post('/parent/save-zone', (req, res) => {
    try {
        // req.body ĐÃ LÀ OBJECT RỒI, KHÔNG CẦN PARSE NỮA!
        const { childUsername, zoneData } = req.body;

        const users = getData(USERS_FILE);
        const pIdx = users.findIndex(u => u.username === req.session.user.username);
        const cIdx = users[pIdx].linkedChildren.findIndex(c => c.childUsername === childUsername);

        if (cIdx !== -1) {
            if (!users[pIdx].linkedChildren[cIdx].safeZones) users[pIdx].linkedChildren[cIdx].safeZones = [];
            zoneData.id = Date.now().toString(); // Tạo ID ngẫu nhiên
            users[pIdx].linkedChildren[cIdx].safeZones.push(zoneData);
            saveData(USERS_FILE, users);
            req.session.user = users[pIdx]; // Cập nhật session
            res.json({ success: true });
        } else {
            res.json({ success: false });
        }
    } catch (error) {
        console.log("❌ Lỗi lúc Lưu Vùng:", error);
        res.json({ success: false });
    }
});

// ==========================================
// API: Xóa 1 vùng cụ thể (Bản Sạch)
// ==========================================
app.post('/parent/delete-zone', (req, res) => {
    try {
        // req.body ĐÃ LÀ OBJECT RỒI, KHÔNG CẦN PARSE NỮA!
        const { childUsername, zoneId } = req.body;

        const users = getData(USERS_FILE);
        const pIdx = users.findIndex(u => u.username === req.session.user.username);
        const cIdx = users[pIdx].linkedChildren.findIndex(c => c.childUsername === childUsername);

        if (cIdx !== -1 && users[pIdx].linkedChildren[cIdx].safeZones) {
            users[pIdx].linkedChildren[cIdx].safeZones = users[pIdx].linkedChildren[cIdx].safeZones.filter(z => z.id !== zoneId);
            saveData(USERS_FILE, users);
            req.session.user = users[pIdx];
            res.json({ success: true });
        } else {
            res.json({ success: false });
        }
    } catch (error) {
        console.log("❌ Lỗi lúc Xóa Vùng:", error);
        res.json({ success: false });
    }
});

app.post('/parent/set-geofence', (req, res) => {
    if (req.session.user?.role !== 'parent') return res.status(403).send('Từ chối truy cập.');
    const { childUsername, radius } = req.body;
    const users = getData(USERS_FILE);
    const pIdx = users.findIndex(u => u.username === req.session.user.username);
    const cIdx = users[pIdx].linkedChildren.findIndex(c => c.childUsername === childUsername);
    if (cIdx !== -1) {
        users[pIdx].linkedChildren[cIdx].safeZone.radius = parseInt(radius);
        saveData(USERS_FILE, users);
        req.session.user = users[pIdx];
    }
    res.redirect('/');
});

app.post('/parent/respond-request', (req, res) => {
    if (req.session.user?.role !== 'parent') return res.status(403).send('Từ chối truy cập.');
    const notifications = getData(NOTIFICATIONS_FILE);
    const idx = notifications.findIndex(n => n.id == req.body.requestId);
    if (idx !== -1) {
        notifications[idx].status = req.body.status;
        saveData(NOTIFICATIONS_FILE, notifications);
    }
    res.redirect('/');
});

app.post('/child/sos', (req, res) => {
    if (req.session.user?.role !== 'child') return res.status(403).send('Từ chối truy cập.');
    const notifications = getData(NOTIFICATIONS_FILE);
    notifications.push({ id: Date.now(), type: 'SOS', from: req.session.user.username, name: req.session.user.name, time: new Date().toLocaleString(), status: 'Critical', msg: 'Tín hiệu SOS KHẨN CẤP!' });
    saveData(NOTIFICATIONS_FILE, notifications);
    res.redirect('/');
});

app.post('/child/request-move', (req, res) => {
    if (req.session.user?.role !== 'child') return res.status(403).send('Từ chối truy cập.');
    const notifications = getData(NOTIFICATIONS_FILE);
    notifications.push({ id: Date.now(), type: 'Request', from: req.session.user.username, name: req.session.user.name, destination: req.body.destination, time: new Date().toLocaleString(), status: 'Pending' });
    saveData(NOTIFICATIONS_FILE, notifications);
    res.redirect('/');
});

// ==========================================
// 6. DASHBOARD CHÍNH (GIAO DIỆN WEB)
// ==========================================
app.get('/', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    const user = req.session.user;
    const users = getData(USERS_FILE);
    const notifications = getData(NOTIFICATIONS_FILE);

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
                        <tr><th>Tên Trẻ</th><th>Geofence (Bán kính)</th><th>Hành động</th></tr>
                        ${user.linkedChildren.map(c => `
                            <tr>
                                <td>${c.childName} <br><small>(@${c.childUsername})</small></td>
                                <td>
                                    <form action="/parent/set-geofence" method="POST" style="display:inline-block;">
                                        <input type="hidden" name="childUsername" value="${c.childUsername}">
                                        <input type="number" name="radius" class="input-box" value="${c.safeZone.radius}" style="width: 70px;">
                                        <button type="submit" class="btn btn-success">Lưu Vùng</button>
                                    </form>
                                </td>
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