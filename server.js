const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const fs = require('fs');
const path = require('path');
const http = require('http'); 
const { Server } = require('socket.io');
const mqtt = require('mqtt');

// ==========================================
// 1. KHỞI TẠO SERVER & KẾT NỐI REAL-TIME
// ==========================================
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = 3000;

app.use(bodyParser.urlencoded({ extended: true }));
app.use(session({
    secret: 'ase_hcmut_clms_group3_final',
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 3600000 }
}));

const USERS_FILE = path.join(__dirname, 'users.json');
const NOTIFICATIONS_FILE = path.join(__dirname, 'notifications.json');
const HISTORY_FILE = path.join(__dirname, 'history.json'); 

if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, JSON.stringify([]));
if (!fs.existsSync(NOTIFICATIONS_FILE)) fs.writeFileSync(NOTIFICATIONS_FILE, JSON.stringify([]));
if (!fs.existsSync(HISTORY_FILE)) fs.writeFileSync(HISTORY_FILE, JSON.stringify([]));

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

// ==========================================
// 3. MQTT BROKER (HIVEMQ CLOUD - NHÓM 3)
// ==========================================
const mqttClient = mqtt.connect('mqtts://eea6ea368a3b45f59f40963f1e2dcf47.s1.eu.hivemq.cloud:8883', {
    username: 'liu_apple',
    password: '@@Dominhhien1305' //please remember to change this
});

mqttClient.on('connect', () => {
    console.log('📡 [MQTT] Đã kết nối với HiveMQ Cloud của nhóm!');
    
    // Lắng nghe theo Topic riêng: clmshk252group3/clms/[DeviceID]
    mqttClient.subscribe('clmshk252group3/clms/#', (err) => {
        if (err) console.log('❌ Lỗi Subscribe:', err);
        else console.log('✅ Đã đăng ký lắng nghe kênh GPS thành công!');
    }); 
});

mqttClient.on('message', (topic, message) => {
    try {
        // Tách Topic để lấy Username của trẻ (DeviceID)
        // Format: clmshk252group3 / clms / leo_test_child
        const parts = topic.split('/');
        const childUsername = parts[2]; 
        
        const data = JSON.parse(message.toString());
        
        if (data._type === 'location' || (data.lat && data.lon)) {
            console.log(`[THÀNH CÔNG] 📍 Đã bắt được GPS từ bé ${childUsername}: Vĩ độ ${data.lat}, Kinh độ ${data.lon}`);
            const currentLocation = { lat: data.lat, lng: data.lon, batt: data.batt || 100 };
            
            const history = getData(HISTORY_FILE);
            history.push({ child: childUsername, location: currentLocation, time: new Date().toISOString() });
            saveData(HISTORY_FILE, history);

            const users = getData(USERS_FILE);
            const notifications = getData(NOTIFICATIONS_FILE);

            users.filter(u => u.role === 'parent').forEach(parent => {
                const childRecord = parent.linkedChildren.find(c => c.childUsername === childUsername);
                if (childRecord) {
                    const isSafe = isInsideCircle(currentLocation, childRecord.safeZone);
                    
                    if (!isSafe) {
                        notifications.push({
                            id: Date.now(), type: 'SOS', from: childUsername, 
                            name: childRecord.childName, time: new Date().toLocaleString(), 
                            status: 'Critical', msg: 'Đã vượt khỏi vùng an toàn!'
                        });
                        saveData(NOTIFICATIONS_FILE, notifications);
                    }

                    // Đẩy dữ liệu qua Socket.io
                    io.emit(`gps-update-${parent.username}`, {
                        childUsername: childUsername,
                        location: currentLocation,
                        isSafe: isSafe
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
    else res.send('<script>alert("Sai tài khoản!"); window.location="/login";</script>');
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
// 5. API NGHIỆP VỤ
// ==========================================
app.post('/admin/delete-user', (req, res) => {
    if (req.session.user?.role !== 'admin') return res.status(403).send('Từ chối.');
    let users = getData(USERS_FILE);
    users = users.filter(u => u.username !== req.body.targetUsername);
    users.forEach(u => { if (u.linkedChildren) u.linkedChildren = u.linkedChildren.filter(c => c.childUsername !== req.body.targetUsername); });
    saveData(USERS_FILE, users);
    res.redirect('/');
});

app.post('/admin/link-pair', (req, res) => {
    if (req.session.user?.role !== 'admin') return res.status(403).send('Từ chối.');
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
    if (req.session.user?.role !== 'parent') return res.status(403).send('Từ chối.');
    const { childUsername } = req.body;
    const users = getData(USERS_FILE);
    const child = users.find(u => u.username === childUsername && u.role === 'child');
    if (!child) return res.send('<script>alert("Không tìm thấy Trẻ em!"); window.location="/";</script>');
    const pIdx = users.findIndex(u => u.username === req.session.user.username);
    if (users[pIdx].linkedChildren.find(c => c.childUsername === childUsername)) return res.redirect('/');
    users[pIdx].linkedChildren.push({ childUsername: child.username, childName: child.name, safeZone: { lat: 10.7723, lng: 106.6581, radius: 500 } });
    saveData(USERS_FILE, users);
    req.session.user = users[pIdx];
    res.redirect('/');
});

app.post('/parent/remove-child', (req, res) => {
    if (req.session.user?.role !== 'parent') return res.status(403).send('Từ chối.');
    const users = getData(USERS_FILE);
    const pIdx = users.findIndex(u => u.username === req.session.user.username);
    users[pIdx].linkedChildren = users[pIdx].linkedChildren.filter(c => c.childUsername !== req.body.childUsername);
    saveData(USERS_FILE, users);
    req.session.user = users[pIdx];
    res.redirect('/');
});

app.post('/parent/set-geofence', (req, res) => {
    if (req.session.user?.role !== 'parent') return res.status(403).send('Từ chối.');
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
    const notifications = getData(NOTIFICATIONS_FILE);
    const idx = notifications.findIndex(n => n.id == req.body.requestId);
    if (idx !== -1) { notifications[idx].status = req.body.status; saveData(NOTIFICATIONS_FILE, notifications); }
    res.redirect('/');
});

app.post('/child/sos', (req, res) => {
    const notifications = getData(NOTIFICATIONS_FILE);
    notifications.push({ id: Date.now(), type: 'SOS', from: req.session.user.username, name: req.session.user.name, time: new Date().toLocaleString(), status: 'Critical', msg: 'SOS KHẨN CẤP TỪ THIẾT BỊ!' });
    saveData(NOTIFICATIONS_FILE, notifications);
    res.redirect('/');
});

app.post('/child/request-move', (req, res) => {
    const notifications = getData(NOTIFICATIONS_FILE);
    notifications.push({ id: Date.now(), type: 'Request', from: req.session.user.username, name: req.session.user.name, destination: req.body.destination, time: new Date().toLocaleString(), status: 'Pending' });
    saveData(NOTIFICATIONS_FILE, notifications);
    res.redirect('/');
});

// ==========================================
// 6. DASHBOARD CHÍNH
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
            #map { height: 400px; width: 100%; border-radius: 8px; z-index: 1; }
            .sos-btn { background: #e74c3c; color: white; border:none; padding:30px; border-radius:50%; width:150px; height:150px; font-size:24px; font-weight:bold; cursor:pointer; margin:auto; display:block; }
        </style>
    </head>
    <body>
        <div class="sidebar">
            <h2 style="text-align:center; border-bottom: 1px solid #444; padding-bottom: 15px;">CLMS</h2>
            <div style="flex-grow: 1;">
                <p>Chào, <strong>${user.name}</strong><br><small>Vai trò: ${user.role}</small></p>
            </div>
            <a href="/logout" style="color:#ff7675; text-decoration:none; text-align:center;">🚪 Đăng xuất</a>
        </div>
        <div class="main">
    `;

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
        `;
    } else if (user.role === 'parent') {
        html += `
            ${notifications.filter(n => n.type === 'SOS' && n.status === 'Critical').length > 0 ? `
                <div class="card" style="background: #fdf2f2; border-left: 5px solid red;">
                    <h3 style="color: red; margin:0;">🚨 CẢNH BÁO SOS</h3>
                    ${notifications.filter(n => n.type === 'SOS' && n.status === 'Critical').map(n => `<p>${n.msg} từ ${n.name} (${n.time})</p>`).join('')}
                </div>
            ` : ''}

            <div class="card">
                <h2>📍 Bản đồ (Live Tracking)</h2>
                <div id="map"></div>
                <div id="status-bar" style="margin-top: 10px; font-size: 14px; color: green; font-weight: bold;">🟢 Đang chờ tín hiệu GPS...</div>
            </div>

            <div class="card" style="display:flex; gap: 20px;">
                <div style="flex:2;">
                    <h3>👦👧 Trẻ đang giám sát</h3>
                    <table>
                        <tr><th>Tên Trẻ</th><th>Geofence (Bán kính)</th><th>Hành động</th></tr>
                        ${user.linkedChildren.map(c => `
                            <tr>
                                <td>${c.childName} (@${c.childUsername})</td>
                                <td>
                                    <form action="/parent/set-geofence" method="POST" style="display:inline-block;">
                                        <input type="hidden" name="childUsername" value="${c.childUsername}">
                                        <input type="number" name="radius" class="input-box" value="${c.safeZone.radius}" style="width: 70px;">
                                        <button type="submit" class="btn btn-success">Lưu</button>
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
                        <input type="text" name="childUsername" class="input-box" style="width:100%; margin-bottom:10px;" placeholder="Username của trẻ (VD: leo_test_child)" required>
                        <button type="submit" class="btn" style="width:100%;">Tạo Liên Kết</button>
                    </form>
                </div>
            </div>

            <script>
                var map = L.map('map').setView([10.7723, 106.6581], 14);
                L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(map);
                
                const childrenData = ${JSON.stringify(user.linkedChildren)};
                const markers = {};
                const circles = {};

                childrenData.forEach(c => {
                    circles[c.childUsername] = L.circle([c.safeZone.lat, c.safeZone.lng], { color: '#8b3fa0', radius: c.safeZone.radius }).addTo(map);
                    markers[c.childUsername] = L.marker([c.safeZone.lat, c.safeZone.lng]).addTo(map).bindPopup("<b>" + c.childName + "</b>");
                });

                const socket = io();
                const myUsername = "${user.username}";
                
                socket.on('gps-update-' + myUsername, function(data) {
                    const statusText = data.isSafe ? '🟢 Đang trong vùng an toàn' : '🔴 CẢNH BÁO: ĐÃ RA KHỎI VÙNG!';
                    document.getElementById('status-bar').innerHTML = '📡 Cập nhật từ ' + data.childUsername + ' | ' + statusText;
                    document.getElementById('status-bar').style.color = data.isSafe ? 'green' : 'red';
                    
                    if(markers[data.childUsername]) {
                        markers[data.childUsername].setLatLng([data.location.lat, data.location.lng]);
                        circles[data.childUsername].setLatLng([data.location.lat, data.location.lng]); // Dời tâm vùng an toàn theo trẻ (có thể tùy chỉnh lại logic này sau nếu cần vùng cố định)
                        map.panTo([data.location.lat, data.location.lng]); 
                    }
                });
            </script>
        `;
    } else if (user.role === 'child') {
        html += `
            <div class="card" style="text-align:center;">
                <h2>TRUNG TÂM KHẨN CẤP</h2>
                <form action="/child/sos" method="POST"><button type="submit" class="sos-btn">SOS</button></form>
            </div>
            <div class="card">
                <h3>🙋 Xin phép</h3>
                <form action="/child/request-move" method="POST">
                    <input type="text" name="destination" class="input-box" style="width:80%;" required>
                    <button type="submit" class="btn">Gửi</button>
                </form>
            </div>
        `;
    }

    html += `</div></body></html>`;
    res.send(html);
});

server.listen(PORT, () => console.log(`🚀 CLMS Real-time Server Running on: http://localhost:${PORT}`));