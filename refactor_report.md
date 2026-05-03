# CLMS-HK252 — Refactor Report

## New File Structure

```
CLMS-HK252/
├── server.js                  ← Entry point only (bootstrap, no logic)
├── db.js                      ← MongoDB connection only
├── package.json
│
├── models/
│   ├── User.js                ← Parent/Admin schema (no child user)
│   ├── History.js             ← GPS coordinate log
│   └── Notification.js        ← GEOFENCE + SOS alerts (parent-bound)
│
├── services/
│   ├── geofence.js            ← Haversine + AABB math (radius + rectangle only)
│   └── mqttService.js         ← MQTT ingestion, geofence eval, socket emit
│
├── middleware/
│   └── auth.js                ← requireLogin / requireRole guards
│
├── routes/
│   ├── auth.js                ← GET/POST /login, /register, /logout
│   ├── admin.js               ← POST /admin/delete-user, /admin/create-parent
│   ├── parent.js              ← POST /parent/add-device, /set-geofence, /acknowledge; GET /history/:childId
│   ├── iot.js                 ← POST /iot/sos (IoT device endpoint, no session)
│   └── dashboard.js           ← GET / (renders Admin or Parent dashboard)
│
└── views/
    ├── login.html             ← Unchanged (minus role context)
    └── register.html          ← Role selector removed; locked to parent
```

---

## 1. Required Changes

### CHANGE 1 — Remove child user accounts
**Rule:** Child acts only as an IoT device. No login, no session, no account.

**Removed:**
- `role: 'child'` enum value from `User` schema
- `/login` accepting child credentials
- `/child/sos` (session-based) → replaced by `/iot/sos` (deviceId-based)
- `/child/request-move` endpoint (no longer part of system)
- Child role dropdown in `register.html`

**Added:**
- `linkedDevices[]` array in `User` schema (replaces `linkedChildren[]`)
- Each device has: `childId`, `childName`, `geofence`

```js
// models/User.js — childDevice embedded in User (parent)
const childDeviceSchema = new mongoose.Schema({
    childId:   { type: String, required: true },
    childName: { type: String, required: true },
    geofence: {
        mode:  { type: String, enum: ['radius', 'rectangle', null], default: null },
        lat: Number, lng: Number,           // radius mode centre
        north: Number, south: Number,       // rectangle bounds
        east:  Number, west:  Number
    }
}, { _id: false });
```

---

### CHANGE 2 — Password hashing with bcrypt
**Rule:** Passwords must be hashed. Plain-text storage/comparison removed.

```js
// routes/auth.js — Registration
const passwordHash = await bcrypt.hash(password, 12);
await User.create({ username, name, role: 'parent', passwordHash, ... });

// routes/auth.js — Login
const user = await User.findOne({ username });
const match = await bcrypt.compare(password, user.passwordHash);
```

**Removed:** `User.findOne({ username, password })` — direct plain-text query.

---

### CHANGE 3 — Remove dangerous MQTT fallback logic
**Rule:** Each device maps to exactly one child. No auto-reassignment.

**Old (removed):**
```js
// REMOVED — assigns GPS to wrong child when topic is ambiguous
if (childUsername === 'clms' || childUsername === 'undefined' || !childUsername) {
    const parentWithChild = await User.findOne({ role: 'parent', ... });
    childUsername = parentWithChild.linkedChildren[0].childUsername;
}
```

**New:**
```js
// services/mqttService.js — Hard fail on bad topic
const childId = parts[parts.length - 1];
if (!childId || childId === 'clms' || childId === 'undefined') {
    console.warn(`[MQTT] Ambiguous topic "${topic}". Discarding.`);
    return;
}
```

---

### CHANGE 4 — Fix Socket.io data leakage
**Rule:** GPS updates and alerts must only go to the correct parent.

**Old (removed):**
```js
// Broadcasts to ALL connected clients — data leakage
io.emit('force-map-update', { lat: data.lat, lng: data.lon });
```

**New:**
```js
// services/mqttService.js — Per-parent private rooms
io.to(`parent:${parent.username}`).emit('gps-update', { ... });
io.to(`parent:${parent.username}`).emit('geofence-alert', { ... });

// Client joins own room after socket connect:
socket.emit('join-parent-room', '${user.username}');
```

```js
// server.js — Room join handler
io.on('connection', (socket) => {
    socket.on('join-parent-room', (username) => {
        socket.join(`parent:${username}`);
    });
});
```

---

### CHANGE 5 — Enforce one geofence mode per device (radius or rectangle only)
**Rule:** Only ONE active geofence. Polygon removed. Radius fixed at 1 km.

**Removed:**
- `isInsidePolygon()` (Ray-casting algorithm)
- `L.Control.Draw` polygon/circle drawing toolbar from frontend
- `safeZones[]` array (multiple zones per child)

**New — one geofence object per device:**
```js
// services/geofence.js
function evaluate(point, geofence) {
    if (!geofence || !geofence.mode) return null;          // No geofence
    if (geofence.mode === 'radius')    return isInsideRadius(point, geofence);
    if (geofence.mode === 'rectangle') return isInsideRectangle(point, geofence);
    return null;
}
// Radius is always fixed: 1000 m (RADIUS_MODE_KM constant)
```

**API enforces mode:**
```js
// routes/parent.js — POST /parent/set-geofence
if (mode === 'radius')    { /* store lat, lng only */ }
if (mode === 'rectangle') { /* store north, south, east, west */ }
if (mode === 'none')      { geofence = { mode: null }; } // disable
```

---

### CHANGE 6 — Notifications bound to specific parent
**Rule:** Alerts must reach only the correct parent. No broadcast.

```js
// models/Notification.js
parentUsername: { type: String, required: true }, // explicit parent binding

// Query always filtered by parentUsername
const notifications = await Notification.find({
    parentUsername: user.username,
    acknowledged: false
});
```

---

### CHANGE 7 — Remove unused JSON file I/O
**Rule:** Use MongoDB. Remove `users.json`, `notifications.json`, `history.json` references.

**Removed from server.js:**
```js
// REMOVED
const USERS_FILE = path.join(__dirname, 'users.json');
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(...);
function getData(file) { ... }
function saveData(file, data) { ... }
```

The `user.json` file in the project root is now unused. It can be deleted.

---

### CHANGE 8 — Separate concerns into modules

| Concern | Old | New |
|---|---|---|
| DB connection | inline `db.js` with schemas | `db.js` connection-only |
| Schemas | all in `db.js` | `models/User.js`, `models/History.js`, `models/Notification.js` |
| Auth routes | mixed into `server.js` | `routes/auth.js` |
| Admin routes | mixed into `server.js` | `routes/admin.js` |
| Parent routes | mixed into `server.js` | `routes/parent.js` |
| IoT/SOS | session-based child route | `routes/iot.js` (no session) |
| Dashboard HTML | 710-line template in `server.js` | `routes/dashboard.js` |
| MQTT + geofence | inline in `server.js` | `services/mqttService.js` + `services/geofence.js` |
| Auth guards | ad-hoc `if (req.session.user.role !== 'x')` | `middleware/auth.js` |

---

### CHANGE 9 — SOS redesigned for IoT device (no session)

**Old:** Child user POSTs `/child/sos` via browser session.
**New:** Hardware device POSTs `/iot/sos` with `childId` in body.

```js
// routes/iot.js — POST /iot/sos
router.post('/sos', async (req, res) => {
    const { childId } = req.body;
    const parents = await User.find({ role: 'parent', 'linkedDevices.childId': childId });
    for (const parent of parents) {
        await Notification.create({ type: 'SOS', childId, parentUsername: parent.username, ... });
        io.to(`parent:${parent.username}`).emit('sos-alert', { ... });
    }
    res.json({ success: true });
});
```

---

## 2. Removed Features

| Feature | Reason |
|---|---|
| Child user accounts (login, session, role) | Children are IoT devices, not system users |
| Child movement permission requests | Removed per spec (child is IoT only) |
| Parent approval/denial workflow | Removed with above |
| Polygon geofence (Ray-casting) | Only radius + rectangle allowed |
| Multiple safe zones per child (`safeZones[]`) | One active geofence per device enforced |
| MQTT topic fallback auto-reassignment | Causes data routing to wrong child |
| Global Socket.io broadcast (`io.emit(...)`) | Data leakage — replaced with room-based emit |
| Plain-text password storage | Security violation — replaced with bcrypt |
| `users.json` / `notifications.json` / `history.json` | Unused — MongoDB used exclusively |
| `index.html` (Arduino Cloud iframe embed) | Replaced by native dashboard |

---

## 3. How to Run

### Prerequisites
- Node.js 18+
- MongoDB running locally on port 27017
- HiveMQ cloud broker accessible (credentials in `services/mqttService.js`)

### Start
```bash
npm install
node server.js
```

### Seed admin account (run once)
```bash
node -e "
require('./db.js');
const bcrypt = require('bcrypt');
const User = require('./models/User');
async function seed() {
    const hash = await bcrypt.hash('admin123', 12);
    await User.create({ username: 'admin', name: 'Administrator', role: 'admin', passwordHash: hash });
    console.log('Admin created'); process.exit();
}
seed();
"
```

### Test main features
1. `http://localhost:3000/register` → Create parent account
2. Login → Link a device (enter Device ID = MQTT topic suffix)
3. Click **Configure Geofence** → choose Radius or Rectangle → save
4. Publish GPS from MQTT client:
   ```
   Topic:   clmshk252group3/clms/<deviceId>
   Payload: {"lat":10.7723,"lon":106.6581,"batt":85}
   ```
5. Test SOS: `POST http://localhost:3000/iot/sos` with body `{ "childId": "<deviceId>" }`
