const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;

// ==========================================
// 1. CẤU HÌNH & KHỞI TẠO FILE DỮ LIỆU
// ==========================================
app.use(bodyParser.urlencoded({ extended: true }));
app.use(session({
    secret: 'ase_hcmut_clms_ultimate',
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 3600000 }
}));

const USERS_FILE = path.join(__dirname, 'users.json');
const NOTIFICATIONS_FILE = path.join(__dirname, 'notifications.json');

if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, JSON.stringify([]));
if (!fs.existsSync(NOTIFICATIONS_FILE)) fs.writeFileSync(NOTIFICATIONS_FILE, JSON.stringify([]));

function getData(file) { return JSON.parse(fs.readFileSync(file)); }
function saveData(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }

// ==========================================
// 2. ROUTES XÁC THỰC (AUTH)
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
    if (role === 'admin') return res.status(403).send('Bảo mật: Không thể đăng ký Admin công khai.');
    if (password !== confirmPassword) return res.send('Mật khẩu không khớp!');
    const users = getData(USERS_FILE);
    if (users.find(u => u.username === username)) return res.send('Username đã tồn tại!');
    users.push({ username, name, role, email, phone, password, linkedChildren: [] });
    saveData(USERS_FILE, users);
    res.send('<script>alert("Đăng ký thành công!"); window.location="/login";</script>');
});

app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });

// ==========================================
// 3. API DÀNH CHO ADMIN
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
        parent.linkedChildren.push({ childUsername: child.username, childName: child.name, childPhone: child.phone, safeZone: { lat: 10.772393, lng: 106.658145, radius: 1000 } });
        saveData(USERS_FILE, users);
    }
    res.redirect('/');
});

// ==========================================
// 4. API DÀNH CHO PARENT (PHỤ HUYNH)
// ==========================================
app.post('/parent/add-child', (req, res) => {
    if (req.session.user?.role !== 'parent') return res.status(403).send('Từ chối.');
    const { childUsername } = req.body;
    const users = getData(USERS_FILE);
    const child = users.find(u => u.username === childUsername && u.role === 'child');
    if (!child) return res.send('<script>alert("Lỗi: Không tìm thấy tài khoản Trẻ em này!"); window.location="/";</script>');
    const parentIndex = users.findIndex(u => u.username === req.session.user.username);
    if (users[parentIndex].linkedChildren.find(c => c.childUsername === childUsername)) {
        return res.send('<script>alert("Trẻ này đã được liên kết rồi!"); window.location="/";</script>');
    }
    users[parentIndex].linkedChildren.push({ childUsername: child.username, childName: child.name, childPhone: child.phone, safeZone: { lat: 10.772393, lng: 106.658145, radius: 1000 } });
    saveData(USERS_FILE, users);
    req.session.user = users[parentIndex];
    res.redirect('/');
});

app.post('/parent/remove-child', (req, res) => {
    if (req.session.user?.role !== 'parent') return res.status(403).send('Từ chối.');
    const users = getData(USERS_FILE);
    const parentIndex = users.findIndex(u => u.username === req.session.user.username);
    users[parentIndex].linkedChildren = users[parentIndex].linkedChildren.filter(c => c.childUsername !== req.body.childUsername);
    saveData(USERS_FILE, users);
    req.session.user = users[parentIndex];
    res.redirect('/');
});

app.post('/parent/set-geofence', (req, res) => {
    if (req.session.user?.role !== 'parent') return res.status(403).send('Từ chối.');
    const { childUsername, radius } = req.body;
    const users = getData(USERS_FILE);
    const parentIndex = users.findIndex(u => u.username === req.session.user.username);
    const childIndex = users[parentIndex].linkedChildren.findIndex(c => c.childUsername === childUsername);
    if (childIndex !== -1) {
        users[parentIndex].linkedChildren[childIndex].safeZone.radius = parseInt(radius);
        saveData(USERS_FILE, users);
        req.session.user = users[parentIndex];
    }
    res.redirect('/');
});

app.post('/parent/respond-request', (req, res) => {
    const { requestId, status } = req.body;
    let notifications = getData(NOTIFICATIONS_FILE);
    const idx = notifications.findIndex(n => n.id == requestId);
    if (idx !== -1) { notifications[idx].status = status; saveData(NOTIFICATIONS_FILE, notifications); }
    res.redirect('/');
});

// ==========================================
// 5. API DÀNH CHO CHILD (TRẺ EM)
// ==========================================
app.post('/child/sos', (req, res) => {
    if (req.session.user?.role !== 'child') return res.status(403).send('Từ chối.');
    const notifications = getData(NOTIFICATIONS_FILE);
    notifications.push({ id: Date.now(), type: 'SOS', from: req.session.user.username, name: req.session.user.name, time: new Date().toLocaleString(), status: 'Critical' });
    saveData(NOTIFICATIONS_FILE, notifications);
    res.send('<script>alert("TÍN HIỆU SOS ĐÃ GỬI ĐẾN BA MẸ!"); window.location="/";</script>');
});

app.post('/child/request-move', (req, res) => {
    const { destination } = req.body;
    const notifications = getData(NOTIFICATIONS_FILE);
    notifications.push({ id: Date.now(), type: 'Request', from: req.session.user.username, name: req.session.user.name, destination: destination, time: new Date().toLocaleString(), status: 'Pending' });
    saveData(NOTIFICATIONS_FILE, notifications);
    res.send('<script>alert("Đã gửi yêu cầu, vui lòng đợi ba mẹ phản hồi!"); window.location="/";</script>');
});

// ==========================================
// 6. TRANG CHỦ DASHBOARD (GIAO DIỆN CHÍNH)
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
        <style>
            body { font-family: 'Segoe UI', Tahoma, sans-serif; margin: 0; display: flex; height: 100vh; background: #f4f7f6; }
            .sidebar { width: 250px; background: #2c3e50; color: white; padding: 20px; box-shadow: 2px 0 5px rgba(0,0,0,0.1); display: flex; flex-direction: column; }
            .main { flex-grow: 1; padding: 30px; overflow-y: auto; }
            .card { background: white; padding: 20px; border-radius: 12px; box-shadow: 0 4px 10px rgba(0,0,0,0.05); margin-bottom: 20px; }
            table { width: 100%; border-collapse: collapse; margin-top: 10px; }
            th, td { text-align: left; padding: 12px; border-bottom: 1px solid #eee; }
            .btn { background: #8b3fa0; color: white; border: none; padding: 8px 15px; border-radius: 4px; cursor: pointer; text-decoration: none; font-size: 13px; }
            .btn-danger { background: #e74c3c; }
            .btn-success { background: #27ae60; }
            .input-box { padding: 8px; border: 1px solid #ccc; border-radius: 4px; }
            #map { height: 400px; border-radius: 8px; width: 100%; border: 2px solid #ddd; z-index: 1;}
            .sos-btn { background: #e74c3c; color: white; border: none; padding: 30px; border-radius: 50%; width: 150px; height: 150px; font-size: 24px; font-weight: bold; cursor: pointer; box-shadow: 0 0 20px rgba(231,76,60,0.5); margin: 20px auto; display: block; animation: pulse 2s infinite; }
            @keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(231, 76, 60, 0.7); } 70% { box-shadow: 0 0 0 20px rgba(231, 76, 60, 0); } 100% { box-shadow: 0 0 0 0 rgba(231, 76, 60, 0); } }
        </style>
    </head>
    <body>
        <div class="sidebar">
            <h2 style="text-align:center; border-bottom: 1px solid #444; padding-bottom: 15px;">CLMS SYSTEM</h2>
            <div style="flex-grow: 1; margin-top: 20px;">
                <p>Xin chào,<br><strong style="font-size: 18px;">${user.name}</strong></p>
                <p style="color:#bdc3c7; font-size: 14px; text-transform: uppercase;">Vai trò: ${user.role}</p>
                ${user.role === 'child' ? `<p style="color:#2ecc71;">📡 GPS: Online</p><p style="color:#f1c40f;">🔋 Pin: 82%</p>` : ''}
            </div>
            <a href="/logout" style="color:#ff7675; text-decoration:none; font-weight: bold; text-align:center; padding: 10px; background: rgba(255,118,117,0.1); border-radius: 5px;">🚪 Đăng xuất</a>
        </div>
        <div class="main">
    `;

    // ==========================================
    // RENDER: GIAO DIỆN ADMIN
    // ==========================================
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
    // ==========================================
    // RENDER: GIAO DIỆN PARENT
    // ==========================================
    else if (user.role === 'parent') {
        html += `
            ${notifications.filter(n => n.type === 'SOS' && n.status === 'Critical').length > 0 ? `
                <div class="card" style="border-left: 5px solid #e74c3c; background: #fdf2f2;">
                    <h3 style="color: #e74c3c; margin-top:0;">🚨 CẢNH BÁO SOS KHẨN CẤP</h3>
                    ${notifications.filter(n => n.type === 'SOS' && n.status === 'Critical').map(n => `
                        <p><strong>Bé ${n.name}</strong> phát tín hiệu SOS lúc ${n.time}!</p>
                    `).join('')}
                </div>
            ` : ''}

            <div class="card">
                <h2>📍 Bản đồ Giám sát (Live Map)</h2>
                <div id="map"></div>
            </div>

            <div style="display: flex; gap: 20px;">
                <div class="card" style="flex: 2;">
                    <h3>👦👧 Trẻ em đang giám sát</h3>
                    <table>
                        <tr><th>Tên Trẻ (Username)</th><th>Hành động (Geofencing)</th></tr>
                        ${user.linkedChildren.map(c => `
                            <tr>
                                <td><strong>${c.childName}</strong><br><small style="color:gray;">(@${c.childUsername})</small></td>
                                <td>
                                    <form action="/parent/set-geofence" method="POST" style="display:inline-block; margin-right: 5px;">
                                        <input type="hidden" name="childUsername" value="${c.childUsername}">
                                        <input type="number" name="radius" class="input-box" value="${c.safeZone.radius}" style="width: 70px;" required>
                                        <button type="submit" class="btn btn-success">Lưu Vùng</button>
                                    </form>
                                    <form action="/parent/remove-child" method="POST" style="display:inline-block;">
                                        <input type="hidden" name="childUsername" value="${c.childUsername}">
                                        <button type="submit" class="btn btn-danger">Hủy LK</button>
                                    </form>
                                </td>
                            </tr>
                        `).join('')}
                    </table>
                </div>

                <div style="flex: 1; display: flex; flex-direction: column; gap: 20px;">
                    <div class="card">
                        <h3 style="margin-top:0;">➕ Thêm liên kết</h3>
                        <form action="/parent/add-child" method="POST">
                            <input type="text" name="childUsername" class="input-box" style="width: 100%; margin-bottom: 10px;" placeholder="Username của trẻ" required>
                            <button type="submit" class="btn" style="width: 100%;">Tạo Liên Kết</button>
                        </form>
                    </div>

                    <div class="card">
                        <h3 style="margin-top:0;">🔔 Yêu cầu di chuyển</h3>
                        ${notifications.filter(n => n.type === 'Request' && n.status === 'Pending').map(n => `
                            <div style="padding-bottom:10px; border-bottom:1px solid #eee;">
                                Bé <strong>${n.name}</strong> xin đi: <em>${n.destination}</em>
                                <form action="/parent/respond-request" method="POST" style="margin-top:10px; display:flex; gap:10px;">
                                    <input type="hidden" name="requestId" value="${n.id}">
                                    <button name="status" value="Approved" class="btn btn-success" style="flex:1;">Đồng ý</button>
                                    <button name="status" value="Denied" class="btn btn-danger" style="flex:1;">Từ chối</button>
                                </form>
                            </div>
                        `).join('') || '<p style="font-size:13px; color:gray;">Không có yêu cầu nào.</p>'}
                    </div>
                </div>
            </div>

            <script>
                var map = L.map('map').setView([10.772393, 106.658145], 14);
                L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap CLMS' }).addTo(map);
                const children = ${JSON.stringify(user.linkedChildren)};
                children.forEach(c => {
                    L.marker([c.safeZone.lat, c.safeZone.lng]).addTo(map).bindPopup("<b>" + c.childName + "</b>");
                    L.circle([c.safeZone.lat, c.safeZone.lng], { color: '#8b3fa0', fillColor: '#9b59b6', fillOpacity: 0.2, radius: c.safeZone.radius }).addTo(map);
                });
            </script>
        `;
    } 
    // ==========================================
    // RENDER: GIAO DIỆN CHILD
    // ==========================================
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
                            <span style="font-weight:bold; color:${n.status==='Approved'?'#27ae60':(n.status==='Denied'?'#e74c3c':'#f39c12')}">
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

app.listen(PORT, () => console.log(`CLMS Ultimate Running: http://localhost:${PORT}`));