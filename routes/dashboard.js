const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Notification = require('../models/Notification');
const { requireLogin } = require('../middleware/auth');
const { RADIUS_MODE_KM } = require('../services/geofence');

router.get('/', requireLogin, async (req, res) => {
    try {
        const sessionUser = req.session.user;
        const user = await User.findOne({ username: sessionUser.username }).lean();
        if (!user) return res.redirect('/logout');

        if (user.role === 'admin') {
            return renderAdminDashboard(res, user);
        }

        if (user.role === 'parent') {
            return renderParentDashboard(res, user);
        }

        return res.redirect('/logout');
    } catch (err) {
        console.error('[Dashboard] Error:', err);
        res.status(500).send('Server error.');
    }
});

async function renderAdminDashboard(res, user) {
    const csrfToken = res.req.session?.csrfToken || '';
    const users = await User.find({ role: { $ne: 'admin' } }).sort({ createdAt: -1 }).lean();
    const totalUsers = users.length;
    const totalParents = users.filter((u) => u.role === 'parent').length;
    const totalDevices = users.reduce((sum, u) => sum + (Array.isArray(u.linkedDevices) ? u.linkedDevices.length : 0), 0);

    const userRows = users.length
        ? users.map((u, index) => `
            <tr>
                <td>
                    <div class="row-title">${escapeHtml(u.username)}</div>
                    <div class="row-sub">${escapeHtml(u.name)}</div>
                </td>
                <td><span class="badge badge-${u.role}">${escapeHtml(u.role)}</span></td>
                <td>${escapeHtml(u.email || '—')}</td>
                <td>${escapeHtml(u.phone || '—')}</td>
                <td>${Array.isArray(u.linkedDevices) ? u.linkedDevices.length : 0}</td>
                <td>
                    <form action="/admin/delete-user" method="POST" class="inline-form">
                        ${csrfField(csrfToken)}
                        <input type="hidden" name="targetUsername" value="${escapeAttr(u.username)}">
                        <button type="submit" class="btn btn-danger btn-sm" onclick="return confirm('Delete ${escapeJs(u.username)}?')">Delete</button>
                    </form>
                </td>
            </tr>`).join('')
        : `<tr><td colspan="6" class="empty-cell">No users registered.</td></tr>`;

    res.send(pageShell({
        title: 'Admin Dashboard',
        activeNav: 'overview',
        user,
        csrfToken,
        navItems: [
            { label: 'Overview', href: '#overview', active: true },
            { label: 'Users', href: '#users' },
            { label: 'Create Parent', href: '#create-parent' },
        ],
        content: `
            <section class="hero-card" id="overview">
                <div class="hero-copy">
                    <div class="eyebrow">ADMIN CONTROL</div>
                    <h1>User Management <span>Console</span></h1>
                    <p>Manage parent accounts, audit registrations, and keep the platform aligned with the purple visual system.</p>
                    <div class="chip-row">
                        <span class="chip">Total users: ${totalUsers}</span>
                        <span class="chip">Parents: ${totalParents}</span>
                        <span class="chip">Devices: ${totalDevices}</span>
                    </div>
                </div>
                <div class="hero-art">
                    <div class="hero-mark">CLMS</div>
                    <div class="hero-stat">
                        <div class="hero-stat-label">Signed in as</div>
                        <div class="hero-stat-value">${escapeHtml(user.name)}</div>
                        <div class="hero-stat-sub">${escapeHtml(user.role)}</div>
                    </div>
                </div>
            </section>

            <section class="section-head" id="users">
                <div>
                <div class="section-label">USER DIRECTORY</div>
                    <h2>Registered Accounts</h2>
                </div>
            </section>

            <section class="panel">
                <div class="table-wrap">
                    <table>
                        <thead>
                            <tr>
                                <th>User</th>
                                <th>Role</th>
                                <th>Email</th>
                                <th>Phone</th>
                                <th>Devices</th>
                                <th>Action</th>
                            </tr>
                        </thead>
                        <tbody>${userRows}</tbody>
                    </table>
                </div>
            </section>

            <section class="section-head" id="create-parent">
                <div>
                <div class="section-label">CREATE ACCOUNT</div>
                    <h2>Create Parent Account</h2>
                </div>
            </section>

            <section class="panel">
                <form action="/admin/create-parent" method="POST" class="form-grid">
                    ${csrfField(csrfToken)}
                    <label class="field">
                        <span>Username</span>
                        <input class="input-box" name="username" placeholder="parent01" required>
                    </label>
                    <label class="field">
                        <span>Full Name</span>
                        <input class="input-box" name="name" placeholder="Parent Name" required>
                    </label>
                    <label class="field">
                        <span>Email</span>
                        <input class="input-box" name="email" placeholder="name@example.com">
                    </label>
                    <label class="field">
                        <span>Phone</span>
                        <input class="input-box" name="phone" placeholder="+62...">
                    </label>
                    <label class="field field-wide">
                        <span>Password</span>
                        <input class="input-box" type="password" name="password" placeholder="Minimum 6 characters" required>
                    </label>
                    <div class="field field-wide action-row">
                        <button type="submit" class="btn btn-success">Create Account</button>
                    </div>
                </form>
            </section>
        `,
    }));
}

async function renderParentDashboard(res, user) {
    const csrfToken = res.req.session?.csrfToken || '';
    const notifications = await Notification.find({
        parentUsername: user.username,
        acknowledged: false,
    }).sort({ time: -1 }).lean();

    const devices = Array.isArray(user.linkedDevices) ? user.linkedDevices : [];
    const sosAlerts = notifications.filter((n) => n.type === 'SOS');
    const geofenceAlerts = notifications.filter((n) => n.type === 'GEOFENCE');
    const totalAlerts = notifications.length;
    const totalDevices = devices.length;
    const activeGeofences = devices.filter((d) => d.geofence && d.geofence.mode).length;

    const deviceCards = devices.length
        ? devices.map((device, index) => `
            <article class="lecture-card">
                <div class="lecture-meta">Device ${String(index + 1).padStart(2, '0')}</div>
                <h3>${escapeHtml(device.childName)}</h3>
                <p class="lecture-desc">${escapeHtml(device.childId)}</p>
                <div class="device-status" id="status-${escapeAttr(device.childId)}">Waiting for live data...</div>
                <div class="tag-row">
                    ${deviceTag('ID', escapeHtml(device.childId))}
                    ${deviceTag('Map', device.geofence?.mode ? escapeHtml(device.geofence.mode) : 'none')}
                    ${deviceTag('Zone', geofenceSummary(device.geofence))}
                </div>
                <div class="card-actions">
                    <button class="btn btn-ghost btn-sm" type="button" onclick="openGeofencePanel('${escapeJs(device.childId)}','${escapeJs(device.childName)}')">Geofence</button>
                    <form action="/parent/remove-device" method="POST" class="inline-form">
                        ${csrfField(csrfToken)}
                        <input type="hidden" name="childId" value="${escapeAttr(device.childId)}">
                        <button type="submit" class="btn btn-danger btn-sm" onclick="return confirm('Remove ${escapeJs(device.childName)}?')">Remove</button>
                    </form>
                </div>
            </article>`).join('')
        : `<div class="empty-card">No devices linked yet.</div>`;

    const alertItems = notifications.length
        ? notifications.map((n) => `
            <div class="alert-item ${n.type.toLowerCase()}" data-notif-id="${escapeAttr(n._id)}">
                <div class="alert-badge">${escapeHtml(n.type)}</div>
                <div class="alert-body">
                    <div class="alert-title">${escapeHtml(n.msg)}</div>
                    <div class="alert-meta">${escapeHtml(formatDate(n.time))}${n.childName ? ` · ${escapeHtml(n.childName)}` : ''}</div>
                </div>
                <button type="button" class="btn btn-ghost btn-sm" data-notif-delete="${escapeAttr(n._id)}">Delete</button>
            </div>`).join('')
        : '<div class="empty-card">No active alerts.</div>';

    const historyOptions = devices.map((d) => `<option value="${escapeAttr(d.childId)}">${escapeHtml(d.childName)} (${escapeHtml(d.childId)})</option>`).join('');
    const deviceMapData = JSON.stringify(devices);

    res.send(pageShell({
        title: 'Parent Dashboard',
        user,
        csrfToken,
        navItems: [
            { label: 'Overview', section: 'overview-panel', active: true },
            { label: 'Recent Alerts', section: 'alerts-panel' },
            { label: 'Device Management', section: 'devices-management-panel' },
            { label: 'Location History', section: 'history-panel' },
            { label: 'MQTT Settings', section: 'mqtt-panel' },
        ],
        extraHead: `
            <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
        `,
        content: `
            <section class="hero-card" id="overview">
                <div class="hero-copy">
                    <div class="hero-intro">
                        <div class="eyebrow">CLMS keeps child tracking, map monitoring, and geofence alerts in one calm workspace.</div>
                        <h1>Child Location Monitoring System</h1>
                        <p>Follow linked devices in real time, manage safe zones, and review alert history from a single dashboard.</p>
                    </div>
                    <div class="chip-row">
                        <span class="chip">Devices <span id="chip-devices">${totalDevices}</span></span>
                        <span class="chip">Alerts <span id="chip-alerts">${totalAlerts}</span></span>
                        <span class="chip">Zones <span id="chip-zones">${activeGeofences}</span></span>
                    </div>
                    <div class="hero-mini-grid">
                        <div class="hero-mini-card">
                            <div class="hero-mini-label">Live map</div>
                            <div class="hero-mini-value">Track every linked child device in real time.</div>
                        </div>
                        <div class="hero-mini-card">
                            <div class="hero-mini-label">Safe zones</div>
                            <div class="hero-mini-value">Draw radius, polygon, or rectangle geofences.</div>
                        </div>
                        <div class="hero-mini-card">
                            <div class="hero-mini-label">Alert flow</div>
                            <div class="hero-mini-value">Review geofence, offline, and SOS alerts quickly.</div>
                        </div>
                    </div>
                </div>
                    <div class="hero-art">
                    <div class="hero-stat">
                        <div class="hero-stat-label">Session active</div>
                        <div class="hero-stat-value">${escapeHtml(user.name)}</div>
                        <div class="hero-stat-sub">Parent</div>
                    </div>
                    <div class="hero-mark">CLMS</div>
                </div>
            </section>

            <section class="panel section-panel alert-panel" id="alerts-panel">
                <div class="section-head compact">
                    <div>
                        <div class="section-label">ALERT FEED</div>
                        <h2>Recent Alerts</h2>
                    </div>
                </div>
                <div class="alerts-list" id="alert-list">
                    ${alertItems}
                </div>
            </section>

            ${sosAlerts.length ? `
                <section class="banner danger floating-alerts">
                    <div class="banner-title">Alerts</div>
                    <div class="banner-list">
                        ${sosAlerts.map((n) => `
                            <div class="banner-item" data-notif-id="${escapeAttr(n._id)}">
                                <div>
                                    <div class="banner-item-title">${escapeHtml(n.msg)}</div>
                                    <div class="banner-item-meta">${escapeHtml(formatDate(n.time))}${n.childName ? ` · ${escapeHtml(n.childName)}` : ''}</div>
                                </div>
                                <button type="button" class="btn btn-sm" data-notif-delete="${escapeAttr(n._id)}">Delete</button>
                            </div>
                        `).join('')}
                    </div>
                </section>
            ` : ''}

            <section class="section-panel active" id="overview-panel">
                <section class="workspace-grid">
                    <div class="panel">
                        <div class="section-head compact">
                            <div>
                                <div class="section-label">DEVICE LIST</div>
                                <h2>Devices</h2>
                            </div>
                        </div>
                        <div class="lecture-grid compact-device-grid">
                            ${deviceCards}
                        </div>
                    </div>

                    <aside class="panel geofence-side" id="geofence-panel">
                        <div class="section-head compact">
                            <div>
                                <h2 id="geofence-title">Select a device</h2>
                            </div>
                        </div>

                        <div class="mode-row">
                            <button type="button" class="btn btn-ghost btn-sm" onclick="selectMode('radius')">Radius 1 km</button>
                            <button type="button" class="btn btn-ghost btn-sm" onclick="selectMode('polygon')">Polygon</button>
                            <button type="button" class="btn btn-ghost btn-sm" onclick="selectMode('rectangle')">Rectangle</button>
                            <button type="button" class="btn btn-danger btn-sm" onclick="selectMode('none')">Remove Zone</button>
                        </div>

                        <input type="hidden" id="gf-childId">
                        <div id="radius-inputs" class="gf-block">
                            <div class="draw-hint">Click once on the map to set the centre point. Radius is fixed at 1 km.</div>
                            <div class="draw-status" id="radius-status">Waiting for map click...</div>
                            <input type="hidden" id="gf-lat">
                            <input type="hidden" id="gf-lng">
                        </div>

                        <div id="polygon-inputs" class="gf-block">
                            <div class="pt-count-row">
                                <label>Points</label>
                                <div class="pt-counter">
                                    <button type="button" onclick="changePointCount(-1)">-</button>
                                    <span id="pt-count-display">4</span>
                                    <button type="button" onclick="changePointCount(1)">+</button>
                                </div>
                            </div>
                            <div class="draw-hint">Click <strong id="pt-count-label">4</strong> points on the map to draw the polygon zone.</div>
                            <div class="draw-status" id="poly-status">Click point 1 of 4 on the map...</div>
                            <div class="poly-info" id="poly-info"></div>
                            <input type="hidden" id="gf-poly-points">
                        </div>

                        <div id="rect-inputs" class="gf-block">
                            <div class="draw-hint">Click 2 corner points on the map to draw a rectangle zone.</div>
                            <div class="draw-status" id="rect-status">Click the first corner on the map...</div>
                            <div class="poly-info" id="rect-info"></div>
                            <input type="hidden" id="gf-north">
                            <input type="hidden" id="gf-south">
                            <input type="hidden" id="gf-east">
                            <input type="hidden" id="gf-west">
                        </div>

                        <div class="action-row">
                            <button type="button" class="btn btn-success" onclick="saveGeofence()">Save Geofence</button>
                        </div>
                    </aside>
                </section>

                <section class="panel" id="map-panel">
                    <div class="section-head compact">
                        <div>
                        <div class="section-label">MAP</div>
                            <h2>Live Map</h2>
                        </div>
                    </div>
                <div id="map" class="map-box"></div>
                <div id="status-bar" class="status-bar">Waiting for GPS signal...</div>
            </section>
            </section>

            <section class="panel section-panel" id="devices-management-panel">
                <div class="section-head compact">
                    <div>
                        <div class="section-label">DEVICE MANAGEMENT</div>
                        <h2>Device Management</h2>
                    </div>
                </div>
                <form action="/parent/add-device" method="POST" class="form-grid form-grid-inline">
                    ${csrfField(csrfToken)}
                    <label class="field field-wide">
                        <span>Device ID</span>
                        <input class="input-box" name="childId" placeholder="MQTT topic suffix" required>
                    </label>
                    <label class="field field-wide">
                        <span>Child Name</span>
                        <input class="input-box" name="childName" placeholder="Child name" required>
                    </label>
                    <div class="field field-wide action-row">
                        <button type="submit" class="btn btn-success">Link Device</button>
                    </div>
                </form>
            </section>

            <section class="panel section-panel" id="history-panel">
                <div class="section-head compact">
                    <div>
                        <div class="section-label">HISTORY</div>
                        <h2>Location History</h2>
                    </div>
                </div>
                <div class="field history-select-field">
                    <span>Select device</span>
                    <select id="history-device-select" class="input-box history-select">
                        <option value="">Select device...</option>
                        ${historyOptions}
                    </select>
                </div>
                <div id="history-list" class="history-list"></div>
            </section>

            <section class="panel section-panel" id="mqtt-panel">
                <div class="section-head compact">
                    <div>
                        <div class="section-label">MQTT SETTINGS</div>
                        <h2>MQTT Configuration</h2>
                        <p>Use these connection values for the child device that publishes GPS data to the dashboard.</p>
                    </div>
                </div>

                <div class="form-grid mqtt-grid">
                    <label class="field field-wide">
                        <span>Mode</span>
                        <input class="input-box" value="MQTT" readonly>
                    </label>
                    <label class="field">
                        <span>Host</span>
                        <input class="input-box" value="eea6ea368a3b45f59f40963f1e2dcf47.s1.eu.hivemq.cloud" readonly>
                    </label>
                    <label class="field">
                        <span>Port</span>
                        <input class="input-box" value="8883" readonly>
                    </label>
                    <label class="field">
                        <span>UserID</span>
                        <input class="input-box" value="liu_apple" readonly>
                    </label>
                    <label class="field">
                        <span>Password</span>
                        <input class="input-box" value="@@Dominhhien1305" readonly>
                    </label>
                    <label class="field field-wide">
                        <span>DeviceID</span>
                        <input class="input-box" value="leo_test_child" readonly>
                    </label>
                    <label class="field field-wide">
                        <span>Base Topic</span>
                        <input class="input-box" value="clmshk252group3/clms" readonly>
                    </label>
                </div>
            </section>
        `,
        extraScript: `
            <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
            <script src="/socket.io/socket.io.js"></script>
            <script>
                const deviceData = ${deviceMapData};
                const liveMarkers = {};
                let geofenceLayer = null;
                let polygonPreviewLayer = null;
                let tempMarker = null;
                let currentMode = null;
                let currentGeofenceChildId = null;
                let rectCorner1 = null;
                let polygonPoints = [];
                let polygonPointMarkers = [];
                let polygonTarget = 4;
                const map = L.map('map').setView([10.7723, 106.6581], 14);

                L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                    attribution: '&copy; OpenStreetMap'
                }).addTo(map);

                deviceData.forEach((device) => {
                    if (!device.geofence || !device.geofence.mode) return;
                    const color = '#9B6DFF';
                    if (device.geofence.mode === 'radius') {
                        L.circle([device.geofence.lat, device.geofence.lng], {
                            radius: ${RADIUS_MODE_KM},
                            color: color,
                            weight: 2,
                            fillColor: color,
                            fillOpacity: 0.12
                        }).addTo(map).bindPopup('<b>' + escapeHtmlClient(device.childName) + '</b><br>Radius 1 km');
                    } else if (device.geofence.mode === 'rectangle') {
                        L.rectangle([[device.geofence.south, device.geofence.west], [device.geofence.north, device.geofence.east]], {
                            color: color,
                            weight: 2,
                            fillColor: color,
                            fillOpacity: 0.12
                        }).addTo(map).bindPopup('<b>' + escapeHtmlClient(device.childName) + '</b><br>Rectangle');
                    } else if (device.geofence.mode === 'polygon' && Array.isArray(device.geofence.points) && device.geofence.points.length >= 3) {
                        L.polygon(device.geofence.points.map((p) => [p.lat, p.lng]), {
                            color: color,
                            weight: 2,
                            fillColor: color,
                            fillOpacity: 0.12
                        }).addTo(map).bindPopup('<b>' + escapeHtmlClient(device.childName) + '</b><br>Polygon');
                    }
                });

                function toast(type, title, msg) {
                    const wrap = document.getElementById('toast-container');
                    const el = document.createElement('div');
                    const normalized = type === 'success' ? 'success' : type === 'alert' ? 'alert' : 'warning';
                    el.className = 'toast ' + normalized;
                    el.innerHTML = '<div class="toast-title">' + escapeHtmlClient(title) + '</div>' + (msg ? '<div class="toast-msg">' + escapeHtmlClient(msg) + '</div>' : '');
                    wrap.appendChild(el);
                    setTimeout(() => el.remove(), 4500);
                }

                function deleteNotification(notifId, button) {
                    fetch('/parent/acknowledge', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/x-www-form-urlencoded',
                            'X-CSRF-Token': window.__CSRF_TOKEN__ || ''
                        },
                        body: new URLSearchParams({ notifId, _csrf: window.__CSRF_TOKEN__ || '' })
                    })
                    .then((resp) => {
                        if (!resp.ok) throw new Error('Request failed');
                        const notifId = button.getAttribute('data-notif-delete');
                        document.querySelectorAll('[data-notif-id="' + notifId + '"]').forEach((row) => row.remove());
                        const list = document.getElementById('alert-list');
                        if (list && !list.querySelector('[data-notif-id]')) {
                            list.innerHTML = '<div class="empty-card">No active alerts.</div>';
                        }
                        const chip = document.getElementById('chip-alerts');
                        if (chip) {
                            const current = parseInt(chip.textContent || '0', 10);
                            chip.textContent = String(Math.max(0, current - 1));
                        }
                    })
                    .catch(() => toast('warning', 'Delete failed', 'Could not remove the alert right now.'));
                }

                function escapeHtmlClient(value) {
                    return String(value || '').replace(/[&<>"']/g, (ch) => ({
                        '&': '&amp;',
                        '<': '&lt;',
                        '>': '&gt;',
                        '"': '&quot;',
                        "'": '&#39;'
                    })[ch]);
                }

                function clearDrawings() {
                    if (geofenceLayer) {
                        map.removeLayer(geofenceLayer);
                        geofenceLayer = null;
                    }
                    if (polygonPreviewLayer) {
                        map.removeLayer(polygonPreviewLayer);
                        polygonPreviewLayer = null;
                    }
                    if (tempMarker) {
                        map.removeLayer(tempMarker);
                        tempMarker = null;
                    }
                    polygonPointMarkers.forEach((marker) => map.removeLayer(marker));
                    polygonPointMarkers = [];
                    rectCorner1 = null;
                    polygonPoints = [];
                }

                function hideGeofencePanel() {
                    document.getElementById('geofence-panel').classList.remove('active');
                    document.getElementById('gf-childId').value = '';
                    document.getElementById('geofence-title').textContent = 'Select a device';
                    currentGeofenceChildId = null;
                    currentMode = null;
                    clearDrawings();
                    resetStatusLabels();
                    document.getElementById('radius-inputs').style.display = 'none';
                    document.getElementById('polygon-inputs').style.display = 'none';
                    document.getElementById('rect-inputs').style.display = 'none';
                }

                function setMode(mode) {
                    currentMode = mode;
                    document.getElementById('radius-inputs').style.display = mode === 'radius' ? 'block' : 'none';
                    document.getElementById('polygon-inputs').style.display = mode === 'polygon' ? 'block' : 'none';
                    document.getElementById('rect-inputs').style.display = mode === 'rectangle' ? 'block' : 'none';
                }

                function resetStatusLabels() {
                    document.getElementById('radius-status').textContent = 'Waiting for map click...';
                    document.getElementById('poly-status').textContent = 'Click point 1 of ' + polygonTarget + ' on the map...';
                    document.getElementById('rect-status').textContent = 'Click the first corner on the map...';
                    document.getElementById('poly-info').style.display = 'none';
                    document.getElementById('rect-info').style.display = 'none';
                }

                function selectMode(mode) {
                    setMode(mode);
                    clearDrawings();
                    resetStatusLabels();
                }

                function changePointCount(delta) {
                    polygonTarget = Math.min(8, Math.max(3, polygonTarget + delta));
                    document.getElementById('pt-count-display').textContent = polygonTarget;
                    document.getElementById('pt-count-label').textContent = polygonTarget;
                    document.getElementById('poly-status').textContent = 'Click point 1 of ' + polygonTarget + ' on the map...';
                    polygonPoints = [];
                    polygonPointMarkers.forEach((marker) => map.removeLayer(marker));
                    polygonPointMarkers = [];
                    if (polygonPreviewLayer) {
                        map.removeLayer(polygonPreviewLayer);
                        polygonPreviewLayer = null;
                    }
                }

                function openGeofencePanel(childId, childName) {
                    if (document.getElementById('geofence-panel').classList.contains('active') && currentGeofenceChildId === childId) {
                        hideGeofencePanel();
                        return;
                    }

                    document.getElementById('gf-childId').value = childId;
                    document.getElementById('geofence-title').textContent = 'Configure Geofence: ' + childName;
                    document.getElementById('geofence-panel').classList.add('active');
                    document.getElementById('geofence-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
                    currentGeofenceChildId = childId;
                    selectMode('radius');
                }

                function saveGeofence() {
                    const childId = document.getElementById('gf-childId').value;
                    if (!childId) {
                        toast('error', 'Missing device', 'Select a device first.');
                        return;
                    }

                    const payload = { childId, mode: currentMode };

                    if (currentMode === 'radius') {
                        payload.lat = document.getElementById('gf-lat').value;
                        payload.lng = document.getElementById('gf-lng').value;
                        if (!payload.lat || !payload.lng) {
                            toast('error', 'Incomplete radius', 'Click the map to set the centre point.');
                            return;
                        }
                    } else if (currentMode === 'rectangle') {
                        payload.north = document.getElementById('gf-north').value;
                        payload.south = document.getElementById('gf-south').value;
                        payload.east = document.getElementById('gf-east').value;
                        payload.west = document.getElementById('gf-west').value;
                        if (!payload.north || !payload.south || !payload.east || !payload.west) {
                            toast('error', 'Incomplete rectangle', 'Click two opposite corners on the map.');
                            return;
                        }
                    } else if (currentMode === 'polygon') {
                        if (!polygonPoints.length || polygonPoints.length < 3) {
                            toast('error', 'Incomplete polygon', 'At least 3 points are required.');
                            return;
                        }
                        payload.points = polygonPoints;
                    } else if (currentMode === 'none') {
                        payload.mode = 'none';
                    } else {
                        toast('error', 'Select a mode', 'Choose radius, polygon, rectangle, or remove zone.');
                        return;
                    }

                    fetch('/parent/set-geofence', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'X-CSRF-Token': window.__CSRF_TOKEN__ || ''
                        },
                        body: JSON.stringify({ ...payload, _csrf: window.__CSRF_TOKEN__ || '' })
                    })
                        .then((r) => r.json())
                        .then((data) => {
                            if (data.success) {
                                toast('success', 'Saved', 'Geofence updated successfully.');
                                setTimeout(() => window.location.reload(), 700);
                            } else {
                                toast('error', 'Save failed', data.error || 'Unknown error.');
                            }
                        })
                        .catch(() => toast('error', 'Network error', 'Could not save geofence.'));
                }

                function renderMarker(position, label) {
                    if (tempMarker) {
                        map.removeLayer(tempMarker);
                    }
                    tempMarker = L.circleMarker(position, {
                        radius: 7,
                        color: '#9B6DFF',
                        weight: 2,
                        fillColor: '#D8C7FF',
                        fillOpacity: 0.9
                    }).addTo(map).bindPopup(label);
                }

                function updatePolygonPreview(finalShape) {
                    if (polygonPreviewLayer) {
                        map.removeLayer(polygonPreviewLayer);
                        polygonPreviewLayer = null;
                    }
                    if (polygonPoints.length < 2) return;

                    const coords = polygonPoints.map((p) => [p.lat, p.lng]);
                    polygonPreviewLayer = finalShape && polygonPoints.length >= 3
                        ? L.polygon(coords, {
                            color: '#9B6DFF',
                            weight: 2,
                            fillColor: '#9B6DFF',
                            fillOpacity: 0.12
                        }).addTo(map)
                        : L.polyline(coords, {
                            color: '#9B6DFF',
                            weight: 2,
                            opacity: 0.95,
                            dashArray: '4,4'
                        }).addTo(map);
                }

                map.on('click', function(e) {
                    if (currentMode === 'radius') {
                        document.getElementById('gf-lat').value = e.latlng.lat.toFixed(6);
                        document.getElementById('gf-lng').value = e.latlng.lng.toFixed(6);
                        if (geofenceLayer) map.removeLayer(geofenceLayer);
                        geofenceLayer = L.circle([e.latlng.lat, e.latlng.lng], {
                            radius: ${RADIUS_MODE_KM},
                            color: '#9B6DFF',
                            weight: 2,
                            fillColor: '#9B6DFF',
                            fillOpacity: 0.12
                        }).addTo(map);
                        renderMarker(e.latlng, 'Radius centre');
                        document.getElementById('radius-status').textContent = 'Centre set at ' + e.latlng.lat.toFixed(5) + ', ' + e.latlng.lng.toFixed(5);
                    } else if (currentMode === 'rectangle') {
                        if (!rectCorner1) {
                            rectCorner1 = e.latlng;
                            renderMarker(e.latlng, 'First corner');
                            document.getElementById('rect-status').textContent = 'First corner selected. Click the opposite corner.';
                        } else {
                            const north = Math.max(rectCorner1.lat, e.latlng.lat);
                            const south = Math.min(rectCorner1.lat, e.latlng.lat);
                            const east = Math.max(rectCorner1.lng, e.latlng.lng);
                            const west = Math.min(rectCorner1.lng, e.latlng.lng);
                            document.getElementById('gf-north').value = north.toFixed(6);
                            document.getElementById('gf-south').value = south.toFixed(6);
                            document.getElementById('gf-east').value = east.toFixed(6);
                            document.getElementById('gf-west').value = west.toFixed(6);
                            if (geofenceLayer) map.removeLayer(geofenceLayer);
                            geofenceLayer = L.rectangle([[south, west], [north, east]], {
                                color: '#9B6DFF',
                                weight: 2,
                                fillColor: '#9B6DFF',
                                fillOpacity: 0.12
                            }).addTo(map);
                            renderMarker(rectCorner1, 'Rectangle start');
                            document.getElementById('rect-info').style.display = 'block';
                            document.getElementById('rect-info').textContent = 'N ' + north.toFixed(4) + ' | S ' + south.toFixed(4) + ' | E ' + east.toFixed(4) + ' | W ' + west.toFixed(4);
                            document.getElementById('rect-status').textContent = 'Rectangle complete.';
                            rectCorner1 = null;
                        }
                    } else if (currentMode === 'polygon') {
                        if (polygonPoints.length >= polygonTarget) return;
                        polygonPoints.push({ lat: e.latlng.lat, lng: e.latlng.lng });
                        const marker = L.circleMarker(e.latlng, {
                            radius: 6,
                            color: '#9B6DFF',
                            weight: 2,
                            fillColor: '#D8C7FF',
                            fillOpacity: 0.95
                        }).addTo(map);
                        polygonPointMarkers.push(marker);
                        updatePolygonPreview(false);
                        document.getElementById('poly-status').textContent = 'Point ' + polygonPoints.length + ' of ' + polygonTarget + ' selected.';

                        if (polygonPoints.length >= polygonTarget) {
                            updatePolygonPreview(true);
                            document.getElementById('poly-info').style.display = 'block';
                            document.getElementById('poly-info').textContent = 'Polygon ready with ' + polygonPoints.length + ' points.';
                            document.getElementById('poly-status').textContent = 'Polygon complete.';
                        }
                    }
                });

                document.getElementById('history-device-select').addEventListener('change', function() {
                    const childId = this.value;
                    const list = document.getElementById('history-list');
                    if (!childId) {
                        list.innerHTML = '';
                        return;
                    }
                    list.innerHTML = '<div class="empty-card">Loading history...</div>';
                    fetch('/parent/history/' + encodeURIComponent(childId))
                        .then((r) => r.json())
                        .then((records) => {
                            if (!records.length) {
                                list.innerHTML = '<div class="empty-card">No history found.</div>';
                                return;
                            }
                            list.innerHTML = records.map((record) => (
                                '<div class="history-row">' +
                                    '<div>' +
                                        '<div class="row-title">' + record.location.lat.toFixed(5) + ', ' + record.location.lng.toFixed(5) + '</div>' +
                                        '<div class="row-sub">Battery ' + record.location.batt + '%</div>' +
                                    '</div>' +
                                    '<div class="row-sub">' + new Date(record.time).toLocaleString() + '</div>' +
                                '</div>'
                            )).join('');
                        })
                        .catch(() => {
                            list.innerHTML = '<div class="empty-card">Failed to load history.</div>';
                        });
                });

                const socket = io();

                socket.on('gps-update', function(data) {
                    const pos = [data.location.lat, data.location.lng];
                    if (liveMarkers[data.childId]) {
                        liveMarkers[data.childId].setLatLng(pos);
                    } else {
                        liveMarkers[data.childId] = L.marker(pos).addTo(map);
                    }
                    liveMarkers[data.childId].bindPopup('<b>' + escapeHtmlClient(data.childName) + '</b>').openPopup();
                    map.setView(pos, 16);

                    const statusBar = document.getElementById('status-bar');
                    statusBar.innerHTML = '<strong>' + escapeHtmlClient(data.childName) + '</strong> located at ' +
                        data.location.lat.toFixed(5) + ', ' + data.location.lng.toFixed(5) +
                        ' | Battery ' + data.batt + '%';

                    const statusCell = document.getElementById('status-' + data.childId);
                    if (statusCell) {
                        statusCell.textContent = data.location.lat.toFixed(5) + ', ' + data.location.lng.toFixed(5) + ' | Batt ' + data.batt + '%';
                    }
                });

                socket.on('geofence-alert', function(data) {
                    toast('alert', data.isSafe ? 'Geofence IN' : 'Geofence OUT', data.msg);

                    const list = document.getElementById('alert-list');
                    const item = document.createElement('div');
                    item.className = 'alert-item ' + (data.isSafe ? 'safe' : 'unsafe');
                    item.innerHTML = '<div class="alert-badge">GEOFENCE</div>' +
                        '<div class="alert-body">' +
                            '<div class="alert-title">' + escapeHtmlClient(data.msg) + '</div>' +
                            '<div class="alert-meta">' + new Date(data.time).toLocaleString() + '</div>' +
                        '</div>';
                    list.insertBefore(item, list.firstChild);
                });

                socket.on('sos-alert', function(data) {
                    toast('alert', 'SOS Emergency', data.msg);
                    setTimeout(() => window.location.reload(), 1600);
                });

                socket.on('device-offline', function(data) {
                    toast('warning', 'Device offline', data.msg || 'A linked device has stopped sending updates.');
                });

                document.addEventListener('click', function(e) {
                    const btn = e.target.closest('[data-notif-delete]');
                    if (!btn) return;
                    deleteNotification(btn.getAttribute('data-notif-delete'), btn);
                });

                setMode('radius');
                resetStatusLabels();
            </script>
        `,
    }));
}

function pageShell({ title, user, navItems, content, extraHead = '', extraScript = '', csrfToken = '' }) {
    const nav = (navItems || []).map((item) => {
        if (item.section) {
            return `<button type="button" class="topnav-pill${item.active ? ' active' : ''}" data-section="${escapeAttr(item.section)}">${escapeHtml(item.label)}</button>`;
        }
        return `<a class="topnav-pill${item.active ? ' active' : ''}" href="${escapeAttr(item.href)}">${escapeHtml(item.label)}</a>`;
    }).join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(title)} - CLMS</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600;9..144,700;9..144,800&family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
    ${extraHead}
    <script>window.__CSRF_TOKEN__ = ${JSON.stringify(csrfToken)};</script>
    <style>
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        :root {
            --bg: #0b0715;
            --bg2: #120a22;
            --panel: rgba(25, 15, 45, 0.88);
            --panel-strong: rgba(30, 18, 56, 0.96);
            --panel-soft: rgba(255, 255, 255, 0.03);
            --border: rgba(181, 145, 255, 0.16);
            --border-strong: rgba(181, 145, 255, 0.26);
            --primary: #8b5cf6;
            --primary-2: #6d28d9;
            --accent: #c4b5fd;
            --text: #f7f2ff;
            --text-2: #c8bddf;
            --text-3: #8d7ba8;
            --danger: #ff6b8a;
            --danger-bg: rgba(255, 107, 138, 0.12);
            --success: #30d6a3;
            --success-bg: rgba(48, 214, 163, 0.12);
            --warning: #f4b860;
            --shadow: 0 24px 80px rgba(0, 0, 0, 0.45);
        }
        body {
            font-family: 'Inter', system-ui, sans-serif;
            color: var(--text);
            min-height: 100vh;
            background:
                radial-gradient(circle at top left, rgba(139, 92, 246, 0.22), transparent 30%),
                radial-gradient(circle at top right, rgba(99, 102, 241, 0.16), transparent 24%),
                linear-gradient(180deg, #0f091c 0%, #090611 100%);
            overflow-x: hidden;
        }
        body::before {
            content: '';
            position: fixed;
            inset: 0;
            pointer-events: none;
            background-image:
                linear-gradient(rgba(196, 181, 253, 0.06) 1px, transparent 1px),
                linear-gradient(90deg, rgba(196, 181, 253, 0.06) 1px, transparent 1px);
            background-size: 54px 54px;
            mask-image: linear-gradient(180deg, rgba(0,0,0,0.55), transparent 88%);
            opacity: 0.4;
        }
        a { color: inherit; }
        .app {
            position: relative;
            z-index: 1;
            width: min(1440px, calc(100vw - 32px));
            margin: 0 auto;
            padding: 20px 0 36px;
        }
        .topbar {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 18px;
            padding: 14px 8px 22px;
            flex-wrap: wrap;
        }
        .brand {
            display: flex;
            align-items: baseline;
            gap: 14px;
            flex-wrap: wrap;
        }
        .brand-name {
            font-family: 'Fraunces', Georgia, serif;
            font-size: 28px;
            font-weight: 800;
            letter-spacing: -0.03em;
            color: var(--accent);
        }
        .topnav {
            display: flex;
            align-items: center;
            gap: 8px;
            flex-wrap: wrap;
            padding: 6px;
            border: 1px solid var(--border);
            background: rgba(52, 28, 104, 0.28);
            border-radius: 999px;
            backdrop-filter: blur(12px);
        }
        .topnav-pill {
            appearance: none;
            -webkit-appearance: none;
            outline: none;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            min-height: 38px;
            padding: 0 16px;
            border-radius: 999px;
            text-decoration: none;
            color: rgba(232, 226, 255, 0.72);
            font-size: 13px;
            font-weight: 700;
            border: 1px solid transparent;
            background: transparent;
            background-clip: padding-box;
            box-shadow: none;
            transition: transform 0.15s ease, background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
        }
        .topnav-pill:hover { background: transparent; color: #fff; border-color: transparent; }
        .topnav-pill.active {
            background: linear-gradient(135deg, var(--primary), var(--primary-2));
            color: #f8f5ff;
            border-color: rgba(196,181,253,0.24);
            box-shadow: 0 8px 18px rgba(139, 92, 246, 0.28);
        }
        .top-actions {
            display: flex;
            align-items: center;
            gap: 10px;
        }
        .signout {
            text-decoration: none;
            color: var(--danger);
            font-weight: 700;
            font-size: 13px;
            padding: 10px 14px;
            border-radius: 999px;
            border: 1px solid rgba(255,107,138,0.25);
            background: rgba(255,107,138,0.06);
        }
        .page {
            display: flex;
            flex-direction: column;
            gap: 18px;
            padding-bottom: 24px;
        }
        .hero-card, .panel, .banner {
            border-radius: 28px;
            border: 1px solid var(--border);
            background: linear-gradient(180deg, rgba(22, 14, 41, 0.96), rgba(14, 10, 26, 0.92));
            box-shadow: var(--shadow);
        }
        .section-panel { display: none; }
        .section-panel.active { display: block; }
        .hero-card {
            padding: 22px;
            display: grid;
            grid-template-columns: minmax(0, 1.7fr) minmax(280px, 0.9fr);
            gap: 16px;
            align-items: start;
            overflow: hidden;
            position: relative;
        }
        .hero-card::after {
            content: '';
            position: absolute;
            inset: auto -100px -140px auto;
            width: 260px;
            height: 260px;
            border-radius: 50%;
            background: radial-gradient(circle, rgba(139,92,246,0.28), transparent 68%);
            pointer-events: none;
        }
        .hero-copy { position: relative; z-index: 1; padding: 4px 4px 2px; }
        .hero-intro { display: flex; flex-direction: column; gap: 8px; }
        .eyebrow {
            font-size: 10px;
            font-weight: 800;
            letter-spacing: 0.08em;
            text-transform: none;
            color: var(--text-2);
            margin-bottom: 8px;
            line-height: 1.4;
            max-width: 70ch;
        }
        .section-label {
            font-size: 11px;
            font-weight: 800;
            letter-spacing: 0.22em;
            text-transform: uppercase;
            color: var(--primary);
            margin-bottom: 12px;
        }
        .hero-copy h1 {
            font-family: 'Fraunces', Georgia, serif;
            font-size: clamp(28px, 4.35vw, 46px);
            line-height: 0.88;
            letter-spacing: -0.05em;
            color: #fffafc;
            margin-bottom: 10px;
        }
        .hero-copy h1 span { color: var(--primary); }
        .hero-copy p, .section-head p {
            font-size: 15px;
            line-height: 1.55;
            color: var(--text-2);
            max-width: 760px;
        }
        .chip-row, .tag-row, .mode-row, .quick-nav {
            display: flex;
            gap: 8px;
            flex-wrap: wrap;
        }
        .quick-nav { margin-top: 2px; }
        .hero-mini-grid {
            display: grid;
            grid-template-columns: repeat(3, minmax(0, 1fr));
            gap: 12px;
            margin-top: 14px;
        }
        .hero-mini-card {
            border-radius: 18px;
            padding: 14px;
            border: 1px solid rgba(139,92,246,0.14);
            background: linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.02));
        }
        .hero-mini-label {
            font-size: 10px;
            font-weight: 800;
            letter-spacing: 0.18em;
            text-transform: uppercase;
            color: var(--primary);
            margin-bottom: 8px;
        }
        .hero-mini-value {
            font-size: 12px;
            line-height: 1.5;
            color: var(--text-2);
        }
        .chip, .tag {
            display: inline-flex;
            align-items: center;
            min-height: 30px;
            padding: 0 12px;
            border-radius: 999px;
            border: 1px solid var(--border);
            background: rgba(255,255,255,0.03);
            color: var(--text-2);
            font-size: 11px;
            font-weight: 700;
        }
        .tag {
            padding: 0 10px;
            min-height: 28px;
            font-size: 11px;
            color: var(--accent);
        }
        .quick-nav-pill {
            display: inline-flex;
            align-items: center;
            min-height: 32px;
            padding: 0 12px;
            border-radius: 999px;
            text-decoration: none;
            font-size: 11px;
            font-weight: 800;
            color: var(--text-2);
            border: 1px solid var(--border);
            background: rgba(255,255,255,0.03);
        }
        .quick-nav-pill:hover {
            color: white;
            border-color: rgba(139,92,246,0.32);
            background: rgba(139,92,246,0.08);
        }
        .hero-art {
            position: relative;
            z-index: 1;
            display: flex;
            flex-direction: column;
            justify-content: flex-start;
            gap: 16px;
            border-radius: 22px;
            padding: 16px 16px 18px;
            background:
                radial-gradient(circle at top, rgba(139,92,246,0.18), transparent 45%),
                linear-gradient(180deg, rgba(255,255,255,0.05), rgba(255,255,255,0.02));
            border: 1px solid var(--border-strong);
        }
        .hero-mark {
            font-family: 'Fraunces', Georgia, serif;
            font-size: clamp(52px, 8.5vw, 102px);
            line-height: 0.9;
            font-weight: 800;
            color: rgba(229, 222, 255, 0.08);
            letter-spacing: -0.08em;
            text-align: right;
        }
        .hero-stat {
            padding: 14px;
            border-radius: 18px;
            background: rgba(255,255,255,0.03);
            border: 1px solid rgba(255,255,255,0.06);
        }
        .hero-stat-label {
            font-size: 11px;
            letter-spacing: 0.16em;
            text-transform: uppercase;
            color: var(--text-3);
            margin-bottom: 8px;
        }
        .hero-stat-value {
            font-size: 20px;
            font-weight: 800;
            color: white;
            margin-bottom: 6px;
        }
        .hero-stat-sub {
            font-size: 13px;
            color: var(--text-2);
        }
        .section-head {
            display: flex;
            justify-content: space-between;
            gap: 18px;
            align-items: end;
            padding: 6px 4px 0;
        }
        .section-head.compact { padding: 0; }
        .section-head h2 {
            font-family: 'Fraunces', Georgia, serif;
            font-size: clamp(32px, 4vw, 54px);
            line-height: 0.98;
            letter-spacing: -0.04em;
            color: #fffafc;
            margin-bottom: 8px;
        }
        .panel {
            padding: 22px;
        }
        .overview-layout {
            display: grid;
            grid-template-columns: minmax(0, 1.15fr) minmax(0, 0.85fr);
            gap: 28px;
            align-items: start;
        }
        .panel-spaced {
            display: grid;
            gap: 18px;
        }
        .lecture-grid {
            display: grid;
            grid-template-columns: repeat(4, minmax(0, 1fr));
            gap: 20px;
        }
        .lecture-card {
            border-radius: 22px;
            padding: 16px 16px 14px;
            border: 1px solid var(--border);
            background: rgba(255,255,255,0.03);
            min-height: 198px;
            display: flex;
            flex-direction: column;
            gap: 9px;
        }
        .lecture-card h3 {
            font-family: 'Fraunces', Georgia, serif;
            font-size: 24px;
            line-height: 1.02;
            letter-spacing: -0.04em;
            color: white;
        }
        .lecture-meta {
            font-size: 11px;
            letter-spacing: 0.18em;
            text-transform: uppercase;
            color: var(--text-3);
        }
        .lecture-desc, .row-sub, .empty-cell, .history-row, .device-status {
            color: var(--text-2);
            font-size: 14px;
            line-height: 1.65;
        }
        .device-status {
            margin-top: auto;
            padding: 10px 12px;
            border-radius: 14px;
            background: rgba(139,92,246,0.08);
            border: 1px solid rgba(139,92,246,0.15);
            color: var(--accent);
            font-weight: 700;
        }
        .card-actions, .action-row, .inline-form {
            display: flex;
            gap: 10px;
            flex-wrap: wrap;
            align-items: center;
        }
        .btn {
            border: none;
            border-radius: 999px;
            padding: 11px 16px;
            font-family: inherit;
            font-size: 13px;
            font-weight: 800;
            cursor: pointer;
            text-decoration: none;
            transition: transform 0.15s ease, box-shadow 0.15s ease, background 0.15s ease;
        }
        .btn:hover { transform: translateY(-1px); }
        .btn:active { transform: translateY(0); }
        .btn-sm { padding: 8px 12px; font-size: 12px; }
        .btn-success {
            color: white;
            background: linear-gradient(135deg, var(--primary), var(--primary-2));
            box-shadow: 0 10px 18px rgba(139,92,246,0.22);
        }
        .btn-danger {
            color: #ffd6e1;
            background: rgba(255,107,138,0.1);
            border: 1px solid rgba(255,107,138,0.22);
        }
        .btn-ghost {
            color: var(--accent);
            background: rgba(255,255,255,0.02);
            border: 1px solid var(--border-strong);
        }
        .input-box {
            width: 100%;
            border-radius: 18px;
            padding: 13px 15px;
            border: 1px solid var(--border);
            background: rgba(255,255,255,0.03);
            color: white;
            font: inherit;
            outline: none;
        }
        .history-select-field { max-width: 380px; }
        .history-select {
            appearance: none;
            -webkit-appearance: none;
            padding-right: 44px;
            background:
                linear-gradient(45deg, transparent 50%, var(--accent) 50%),
                linear-gradient(135deg, var(--accent) 50%, transparent 50%),
                linear-gradient(to right, rgba(139,92,246,0.08), rgba(139,92,246,0.08));
            background-position:
                calc(100% - 20px) 52%,
                calc(100% - 14px) 52%,
                0 0;
            background-size: 6px 6px, 6px 6px, 100% 100%;
            background-repeat: no-repeat;
            cursor: pointer;
        }
        .history-select option {
            background: #1a1230;
            color: #f5f3ff;
        }
        .input-box:focus {
            border-color: rgba(139,92,246,0.5);
            box-shadow: 0 0 0 4px rgba(139,92,246,0.12);
        }
        .form-grid {
            display: grid;
            gap: 14px;
            grid-template-columns: repeat(2, minmax(0, 1fr));
        }
        .form-grid-inline { align-items: end; }
        .field {
            display: flex;
            flex-direction: column;
            gap: 8px;
        }
        .field span {
            font-size: 12px;
            font-weight: 800;
            letter-spacing: 0.12em;
            text-transform: uppercase;
            color: var(--text-3);
        }
        .field-wide { grid-column: span 2; }
        .table-wrap { overflow-x: auto; }
        table { width: 100%; border-collapse: collapse; }
        th, td {
            text-align: left;
            padding: 14px 12px;
            border-bottom: 1px solid rgba(181,145,255,0.12);
            vertical-align: top;
        }
        th {
            font-size: 11px;
            text-transform: uppercase;
            letter-spacing: 0.14em;
            color: var(--text-3);
        }
        td { color: var(--text-2); }
        tr:last-child td { border-bottom: none; }
        .row-title {
            color: white;
            font-weight: 800;
            margin-bottom: 2px;
        }
        .badge {
            display: inline-flex;
            align-items: center;
            min-height: 28px;
            padding: 0 11px;
            border-radius: 999px;
            font-size: 11px;
            font-weight: 800;
            letter-spacing: 0.08em;
            text-transform: uppercase;
        }
        .badge-parent { background: rgba(48,214,163,0.12); color: var(--success); border: 1px solid rgba(48,214,163,0.22); }
        .badge-admin { background: rgba(255,107,138,0.12); color: var(--danger); border: 1px solid rgba(255,107,138,0.22); }
        .banner {
            padding: 18px 20px;
            background: linear-gradient(135deg, rgba(255,107,138,0.15), rgba(139,92,246,0.12));
            border-color: rgba(255,107,138,0.22);
        }
        .floating-alerts {
            position: sticky;
            top: 14px;
            z-index: 25;
            margin-bottom: 4px;
            box-shadow: 0 0 0 1px rgba(255,107,138,0.08), 0 20px 50px rgba(255,107,138,0.18), 0 0 42px rgba(139,92,246,0.18);
            animation: glowPulse 2.8s ease-in-out infinite;
        }
        .alert-panel {
            border-color: rgba(139,92,246,0.22);
            box-shadow: 0 18px 44px rgba(139,92,246,0.12), 0 0 30px rgba(139,92,246,0.1);
        }
        .banner-title {
            font-size: 12px;
            font-weight: 900;
            letter-spacing: 0.16em;
            text-transform: uppercase;
            color: #ffd6e1;
            margin-bottom: 12px;
        }
        .banner-list { display: grid; gap: 10px; }
        .banner-item, .alert-item, .history-row {
            display: flex;
            align-items: center;
            gap: 14px;
            justify-content: space-between;
            padding: 12px 0;
        }
        .banner-item { border-top: 1px solid rgba(255,255,255,0.07); }
        .banner-item:first-child { border-top: none; padding-top: 0; }
        .banner-item-title, .alert-title { color: white; font-weight: 700; }
        .banner-item-meta, .alert-meta { font-size: 12px; color: var(--text-3); margin-top: 3px; }
        .alerts-list, .history-list {
            display: grid;
            gap: 10px;
        }
        .alert-item {
            padding: 14px 16px;
            border-radius: 18px;
            border: 1px solid rgba(181,145,255,0.12);
            background: rgba(255,255,255,0.03);
            box-shadow: 0 10px 24px rgba(0,0,0,0.14);
        }
        .alert-item.sos, .alert-item.offline { border-color: rgba(255,107,138,0.18); background: rgba(255,107,138,0.06); }
        .alert-item.gofence { border-color: rgba(139,92,246,0.18); background: rgba(139,92,246,0.06); }
        .alert-badge {
            min-width: 78px;
            padding: 7px 10px;
            border-radius: 999px;
            text-align: center;
            font-size: 11px;
            font-weight: 900;
            letter-spacing: 0.08em;
            color: var(--accent);
            background: rgba(139,92,246,0.12);
            border: 1px solid rgba(139,92,246,0.16);
        }
        .alert-body { flex: 1; min-width: 0; }
        .map-box {
            min-height: 460px;
            border-radius: 22px;
            overflow: hidden;
            border: 1px solid rgba(181,145,255,0.16);
            background: rgba(255,255,255,0.03);
        }
        .status-bar {
            margin-top: 10px;
            color: var(--text-2);
            font-size: 13px;
        }
        .tabs {
            display: flex;
            gap: 8px;
            flex-wrap: wrap;
        }
        .tab-btn {
            border: 1px solid var(--border);
            background: rgba(255,255,255,0.03);
            color: var(--text-2);
            padding: 10px 16px;
            border-radius: 999px;
            font-family: inherit;
            font-weight: 800;
            cursor: pointer;
        }
        .tab-btn.active {
            color: white;
            background: linear-gradient(135deg, var(--primary), var(--primary-2));
            border-color: transparent;
        }
        .tab-content { display: none; }
        .tab-content.active { display: block; }
        .gf-block {
            display: none;
            padding: 16px 0 0;
            border-top: 1px solid rgba(181,145,255,0.12);
            margin-top: 16px;
        }
        .draw-hint {
            color: var(--text-2);
            margin-bottom: 12px;
            line-height: 1.6;
        }
        .draw-status {
            color: var(--accent);
            font-size: 13px;
            font-weight: 700;
            margin-bottom: 10px;
        }
        .poly-info {
            display: none;
            margin-top: 12px;
            padding: 10px 12px;
            border-radius: 14px;
            color: var(--text-2);
            background: rgba(255,255,255,0.03);
            border: 1px solid rgba(181,145,255,0.12);
        }
        .pt-count-row {
            display: flex;
            align-items: center;
            gap: 14px;
            margin-bottom: 10px;
        }
        .pt-count-row label {
            font-size: 12px;
            font-weight: 800;
            letter-spacing: 0.12em;
            text-transform: uppercase;
            color: var(--text-3);
        }
        .pt-counter {
            display: inline-flex;
            align-items: center;
            gap: 8px;
        }
        .pt-counter button {
            width: 30px;
            height: 30px;
            border-radius: 10px;
            border: 1px solid var(--border);
            background: rgba(255,255,255,0.03);
            color: white;
            cursor: pointer;
        }
        .pt-counter span {
            min-width: 24px;
            text-align: center;
            font-weight: 800;
            color: white;
        }
        .empty-card, .empty-cell {
            padding: 20px;
            border-radius: 18px;
            border: 1px dashed rgba(181,145,255,0.16);
            background: rgba(255,255,255,0.02);
            text-align: center;
        }
        .workspace-grid {
            display: grid;
            grid-template-columns: minmax(0, 1.3fr) minmax(340px, 0.9fr);
            gap: 22px;
            align-items: start;
            margin-bottom: 20px;
        }
        .geofence-side {
            display: none;
            position: sticky;
            top: 90px;
            align-self: start;
        }
        .geofence-side.active {
            display: block;
        }
        .geofence-side .mode-row { margin-bottom: 6px; }
        .action-row { margin-top: 16px; }
        .mqtt-grid { margin-top: 14px; }
        @keyframes glowPulse {
            0%, 100% { filter: brightness(1); transform: translateY(0); }
            50% { filter: brightness(1.08); transform: translateY(-1px); }
        }
        #toast-container {
            position: fixed;
            top: 18px;
            left: 50%;
            bottom: auto;
            display: flex;
            flex-direction: column;
            gap: 10px;
            z-index: 10000;
            transform: translateX(-50%);
            align-items: stretch;
        }
        .toast {
            min-width: 260px;
            max-width: 360px;
            padding: 14px 16px;
            border-radius: 16px;
            background: rgba(21, 13, 39, 0.96);
            border: 1px solid rgba(181,145,255,0.16);
            box-shadow: var(--shadow);
        }
        .toast-title { font-weight: 800; color: white; }
        .toast-msg { margin-top: 4px; font-size: 12px; color: var(--text-2); line-height: 1.5; }
        .toast.success {
            border-color: rgba(48,214,163,0.4);
            box-shadow: 0 0 0 1px rgba(48,214,163,0.14), 0 16px 36px rgba(48,214,163,0.16);
        }
        .toast.warning {
            border-color: rgba(244,184,96,0.42);
            box-shadow: 0 0 0 1px rgba(244,184,96,0.14), 0 16px 36px rgba(244,184,96,0.16);
        }
        .toast.alert {
            border-color: rgba(239,68,68,0.46);
            box-shadow: 0 0 0 1px rgba(239,68,68,0.16), 0 16px 36px rgba(239,68,68,0.18);
        }
        @media (max-width: 1160px) {
            .lecture-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
            .hero-card { grid-template-columns: 1fr; }
            .hero-mini-grid { grid-template-columns: 1fr; }
            .workspace-grid { grid-template-columns: 1fr; }
            .overview-layout { grid-template-columns: 1fr; }
            .geofence-side { position: static; }
            .section-head { align-items: start; flex-direction: column; }
        }
        @media (max-width: 760px) {
            .app { width: min(100vw - 20px, 100vw); }
            .topbar { padding-inline: 0; }
            .topnav { width: 100%; justify-content: flex-start; overflow-x: auto; }
            .top-actions { width: 100%; justify-content: space-between; }
            .lecture-grid { grid-template-columns: 1fr; }
            .form-grid { grid-template-columns: 1fr; }
            .field-wide { grid-column: span 1; }
            .hero-card { padding: 18px; }
            .hero-copy h1 { font-size: 26px; }
            .hero-copy p, .section-head p { font-size: 13px; }
            .hero-mini-grid { grid-template-columns: 1fr; }
            .hero-mark { font-size: 68px; }
            .panel, .hero-card, .banner { border-radius: 22px; }
        }
    </style>
</head>
<body>
    <div class="app">
        <header class="topbar">
            <div class="brand">
                <div class="brand-name">CLMS</div>
            </div>
            <nav class="topnav">
                ${nav}
            </nav>
                <div class="top-actions">
                <a class="signout" href="/logout">Sign Out</a>
            </div>
        </header>

        <main class="page">
            ${content}
        </main>
    </div>

    <div id="toast-container"></div>
        ${extraScript}
        <script>
        (function() {
            const buttons = Array.from(document.querySelectorAll('.topnav-pill[data-section]'));
            const panels = Array.from(document.querySelectorAll('.section-panel'));
            function showSection(id) {
                panels.forEach((panel) => panel.classList.toggle('active', panel.id === id));
                buttons.forEach((btn) => btn.classList.toggle('active', btn.dataset.section === id));
                const target = document.getElementById(id);
                if (target && typeof target.scrollIntoView === 'function') {
                    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }
            }
            buttons.forEach((btn) => {
                btn.addEventListener('click', function() {
                    showSection(this.dataset.section);
                });
            });
        })();
        </script>
    </body>
</html>`;
}

function deviceTag(label, value) {
    return `<span class="tag">${escapeHtml(label)}: ${escapeHtml(value)}</span>`;
}

function csrfField(token) {
    return token ? `<input type="hidden" name="_csrf" value="${escapeAttr(token)}">` : '';
}

function geofenceSummary(gf) {
    if (!gf || !gf.mode) return 'none';
    if (gf.mode === 'radius') return 'radius 1 km';
    if (gf.mode === 'polygon') return `${Array.isArray(gf.points) ? gf.points.length : 0} points`;
    if (gf.mode === 'rectangle') return 'rectangle';
    return 'none';
}

function formatDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Unknown time';
    return date.toLocaleString();
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
    })[ch]);
}

function escapeAttr(value) {
    return escapeHtml(value).replace(/`/g, '&#96;');
}

function escapeJs(value) {
    return String(value ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

module.exports = router;
