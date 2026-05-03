# CLMS Deep Technical Audit

## 1. SYSTEM OVERVIEW

File: D:/CLMS/CLMS-HK252/server.js

Code:
```js
const sessionMiddleware = session({
    secret:            sessionSecret,
    resave:            false,
    saveUninitialized: false,
    cookie: {
        maxAge:   3600000,
        httpOnly: true,
        secure:   process.env.NODE_ENV === 'production',
        sameSite: 'strict'
    }
});

app.use(sessionMiddleware);
app.use(ensureCsrfToken);
app.use(verifyCsrf);

app.use('/iot',     require('./routes/iot'));
app.use('/admin',   require('./routes/admin'));
app.use('/parent',  require('./routes/parent'));
app.use('/',        require('./routes/auth'));
app.use('/',        require('./routes/dashboard'));

require('./services/mqttService').init(io);
require('./services/heartbeat').init(io);
require('./services/worker').init(io);
```

File: D:/CLMS/CLMS-HK252/services/mqttService.js

Code:
```js
mqttClient.on('message', async (topic, message) => {
    const parts   = topic.split('/');
    const childId = parts[parts.length - 1];

    let data;
    try {
        data = JSON.parse(message.toString());
    } catch (_) {
        logger.warn(MOD, `Malformed JSON from ${childId}. Discarding.`);
        return;
    }

    if (data._type !== 'location') {
        return;
    }

    if (!isValidCoord(lat, lng)) {
        logger.warn(MOD, `Invalid coordinates from ${childId}: lat=${lat}, lng=${lng}. Discarding.`);
        return;
    }

    await processMessage(childId, { lat, lng, batt });
});
```

Explanation:
CLMS is implemented as a Node.js and Express application that accepts authenticated web sessions, renders dashboards server-side, and consumes MQTT location events from child devices. The real data flow is: MQTT topic message -> JSON parse -> coordinate validation -> parent lookup -> history persistence -> heartbeat update -> geofence evaluation -> notification delivery -> Socket.IO emit to the parent room. The server bootstraps MQTT, heartbeat, and the queue worker after route registration, so the runtime is a single-process event pipeline with persistence layered through MongoDB and file fallbacks.

## 2. ARCHITECTURE BREAKDOWN

### 2.1 server.js

File: D:/CLMS/CLMS-HK252/server.js

Code:
```js
const useHttps = /^(true|1)$/i.test(String(process.env.ENABLE_HTTPS || ''));
const server = createServer(app, useHttps);
const io     = new Server(server);
const sessionSecret = process.env.SESSION_SECRET || (process.env.NODE_ENV === 'production' ? null : crypto.randomBytes(48).toString('hex'));

io.use((socket, next) => sessionMiddleware(socket.request, {}, next));
io.use((socket, next) => {
    const user = socket.request.session?.user;
    if (!user) return next(new Error('unauthorized'));
    socket.data.user = user;
    next();
});
```

Explanation:
This is the composition root. It wires session middleware, CSRF middleware, Socket.IO auth, route mounting, MongoDB startup, and the background services. It also exposes HTTPS as a toggle, but the server still falls back to HTTP when cert paths are absent. The architecture remains single-node and process-local for transport and session state.

### 2.2 middleware/auth.js

File: D:/CLMS/CLMS-HK252/middleware/auth.js

Code:
```js
function requireLogin(req, res, next) {
    if (!req.session?.user) return res.redirect('/login');
    next();
}

function requireRole(...roles) {
    return (req, res, next) => {
        if (!req.session?.user) return res.redirect('/login');
        if (!roles.includes(req.session.user.role))
            return res.status(403).send('Access denied.');
        next();
    };
}
```

Explanation:
This is the only explicit web authorization guard in the repo. The dashboard and parent routes rely on these checks to prevent anonymous access and role escalation in browser-based flows.

### 2.3 middleware/csrf.js

File: D:/CLMS/CLMS-HK252/middleware/csrf.js

Code:
```js
function verifyCsrf(req, res, next) {
    if (req.method !== 'POST') return next();

    if (req.path.startsWith('/iot/')) return next();

    const expected = req.session?.csrfToken;
    const submitted = req.body?._csrf || req.get('x-csrf-token');

    if (!expected || !submitted) {
        return res.status(403).send('CSRF validation failed.');
    }
    ...
}
```

Explanation:
This middleware creates a session token and verifies POST requests against it. The implementation intentionally bypasses all `/iot/*` requests, so the CSRF guarantee is not uniform across all POST routes.

### 2.4 routes/auth.js

File: D:/CLMS/CLMS-HK252/routes/auth.js

Code:
```js
router.get('/login', (req, res) => {
    if (req.session?.user) return res.redirect('/');
    const html = fs.readFileSync(path.join(__dirname, '..', 'views', 'login.html'), 'utf8')
        .replaceAll('{{CSRF_TOKEN}}', req.session?.csrfToken || '');
    res.send(html);
});

router.post('/login', loginLimiter, async (req, res) => {
    const { username, password } = req.body;
    ...
});
```

Explanation:
Auth is session-based and uses bcrypt for password checks. Login and register pages are no longer static file sends; they are token-injected at request time so the forms can post CSRF data.

### 2.5 routes/dashboard.js

File: D:/CLMS/CLMS-HK252/routes/dashboard.js

Code:
```js
router.get('/', requireLogin, async (req, res) => {
    const user = await User.findOne({ username: sessionUser.username }).lean();
    if (user.role === 'admin') return renderAdminDashboard(res, user);
    if (user.role === 'parent') return renderParentDashboard(res, user);
});

fetch('/parent/set-geofence', {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': window.__CSRF_TOKEN__ || ''
    },
    body: JSON.stringify({ ...payload, _csrf: window.__CSRF_TOKEN__ || '' })
})
```

Explanation:
The dashboard is server-rendered and contains both the UI and the client-side Socket.IO/Leaflet workflow. It is also the main place where CSRF tokens are injected into forms and AJAX writes.

### 2.6 routes/parent.js

File: D:/CLMS/CLMS-HK252/routes/parent.js

Code:
```js
router.use(requireRole('parent'));

router.post('/set-geofence', async (req, res) => {
    ...
    parent.linkedDevices[deviceIdx].geofenceState = null;
    await parent.save();
    res.json({ success: true });
});

router.get('/history/:childId', async (req, res) => {
    const parent = await User.findOne({
        username: req.session.user.username,
        'linkedDevices.childId': childId
    });
    ...
});
```

Explanation:
Parent-only operations are centralized here: add/remove device, set geofence, acknowledge alerts, and read history. The code still depends on the session user and the linkedDevices array for ownership checks.

### 2.7 routes/iot.js

File: D:/CLMS/CLMS-HK252/routes/iot.js

Code:
```js
router.post('/sos', async (req, res) => {
    const { childId, deviceSecret } = req.body;
    if (!childId) return res.status(400).json({ error: 'childId is required.' });
    if (!deviceSecret || deviceSecret.length < 8)
        return res.status(400).send('Invalid deviceSecret');
    ...
});

router.post('/register-secret', async (req, res) => {
    const { childId, deviceSecret } = req.body;
    const parent = await User.findOne({ "linkedDevices.childId": childId });
    ...
});
```

Explanation:
This route family handles device SOS and parent-side secret registration. SOS validates a shared secret against the stored bcrypt hash, while register-secret updates the device secret in the parent document.

### 2.8 services/mqttService.js

File: D:/CLMS/CLMS-HK252/services/mqttService.js

Code:
```js
const MQTT_URL = process.env.MQTT_URL;
const MQTT_USERNAME = process.env.MQTT_USERNAME;
const MQTT_PASSWORD = process.env.MQTT_PASSWORD;
const MQTT_TOPIC_PREFIX = process.env.MQTT_TOPIC_PREFIX || 'clmshk252group3/clms';
...
if (!MQTT_URL || !MQTT_USERNAME || !MQTT_PASSWORD) {
    logger.error(MOD, 'MQTT_URL, MQTT_USERNAME, and MQTT_PASSWORD must be set in the environment. MQTT connection disabled.');
    return;
}
```

Explanation:
This service is the main ingestion pipeline for GPS telemetry. It connects to HiveMQ, subscribes to the device topic prefix, rejects malformed payloads, validates coordinates, resolves parent ownership, persists history, updates heartbeat state, evaluates geofence, and emits notifications to the parent room.

### 2.9 services/heartbeat.js

File: D:/CLMS/CLMS-HK252/services/heartbeat.js

Code:
```js
async function recordSeen(parentUsername, childId) {
    await User.updateOne(
        { username: parentUsername, 'linkedDevices.childId': childId },
        { $set: { 'linkedDevices.$.lastSeen': new Date(), 'linkedDevices.$.offlineAlertActive': false, 'linkedDevices.$.offlineAlertAt': null } }
    );
}

if (elapsed > OFFLINE_THRESHOLD_MS && !device.offlineAlertActive) {
    await User.updateOne(
        { username: parent.username, 'linkedDevices.childId': device.childId },
        {
            $set: {
                'linkedDevices.$.offlineAlertActive': true,
                'linkedDevices.$.offlineAlertAt': new Date()
            }
        }
    );
}
```

Explanation:
Heartbeat is the offline detector. It persists last-seen timestamps and suppresses duplicate offline alerts by storing offline state in MongoDB instead of a process-local set.

### 2.10 services/queueService.js

File: D:/CLMS/CLMS-HK252/services/queueService.js

Code:
```js
const memoryBuffer = [];

async function enqueue(eventType, payload, maxAttempts = 5) {
    if (mongoose.connection.readyState !== 1) {
        if (memoryBuffer.length < MAX_MEMORY_BUFFER) {
            memoryBuffer.push({ eventType, payload, maxAttempts, bufferedAt: new Date() });
        }
        return null;
    }
    return await PendingEvent.create({ eventType, payload, maxAttempts });
}

async function claimNextPending() {
    return await PendingEvent.findOneAndUpdate(
        { status: 'pending', nextRetryAt: { $lte: new Date() } },
        { $set: { status: 'processing' }, $inc: { attempts: 1 } },
        { sort: { createdAt: 1 }, returnDocument: 'after' }
    );
}
```

Explanation:
This is the persistent work queue. It gives at-least-once processing through MongoDB, but it still has an in-memory buffer for short DB outages.

### 2.11 services/dbService.js

File: D:/CLMS/CLMS-HK252/services/dbService.js

Code:
```js
async function writeHistory(payload) {
    try {
        const doc = await withRetry(() => History.create(payload), 'history-primary');
        BackupHistory.create({ ...payload, sourceFail: false }).catch(() => {});
        return doc;
    } catch (primaryErr) {
        try {
            const doc = await withRetry(() => BackupHistory.create({ ...payload, sourceFail: true }), 'history-backup');
            return doc;
        } catch (backupErr) {
            writeFallbackFile('history', payload);
            return null;
        }
    }
}
```

Explanation:
This service implements the application-level write-through fallback chain for history and notifications. Primary collection failure falls back to a backup collection, then to a file log.

### 2.12 services/fallbackNotifier.js

File: D:/CLMS/CLMS-HK252/services/fallbackNotifier.js

Code:
```js
async function deliverAlert(io, parentUsername, event, payload) {
    const room = `parent:${parentUsername}`;
    const sockets = await io.in(room).fetchSockets();
    const wsOnline = sockets.length > 0;

    io.to(room).emit(event, payload);

    if (wsOnline) {
        ...
    } else {
        const emailSent = simulateEmail(parentUsername, payload);
        if (!emailSent) {
            await queueService.enqueue('notification_retry', { parentUsername, event, payload }, 3);
        }
    }
}
```

Explanation:
Alert delivery is multi-channel at application level. WebSocket is primary, simulated email logs are secondary, and queue retry is tertiary.

### 2.13 services/geofence.js

File: D:/CLMS/CLMS-HK252/services/geofence.js

Code:
```js
if (secondary !== null && primary !== secondary) {
    logger.warn(MOD,
        `Algorithm diversity MISMATCH for device at (${point.lat},${point.lng}) ` +
        `mode=${gf.mode}: primary=${primary}, secondary=${secondary}. ` +
        `Fail-safe forcing OUTSIDE.`
    );
    return false;
}
```

Explanation:
Geofence evaluation uses two independent algorithms per shape. If they disagree, the code fails safe by treating the point as outside.

### 2.14 models/User.js

File: D:/CLMS/CLMS-HK252/models/User.js

Code:
```js
const childDeviceSchema = new mongoose.Schema({
    childId:      { type: String, required: true },
    childName:    { type: String, required: true },
    deviceSecret: { type: String, default: null },
    geofenceState: { type: Boolean, default: null },
    lastSeen:     { type: Date, default: null },
    offlineAlertActive: { type: Boolean, default: false },
    offlineAlertAt:     { type: Date, default: null },
    geofence: {
        mode:   { type: String, enum: ['radius', 'rectangle', 'polygon', null], default: null },
        ...
    }
}, { _id: false });
```

Explanation:
The user document stores both account data and linked child-device state. Offline deduplication and geofence state now survive restarts because they are persisted in the user subdocument.

### 2.15 models/Notification.js

File: D:/CLMS/CLMS-HK252/models/Notification.js

Code:
```js
const notificationSchema = new mongoose.Schema({
    type:           { type: String, enum: ['GEOFENCE', 'SOS', 'OFFLINE'], required: true },
    childId:        { type: String, required: true },
    parentUsername: { type: String, required: true },
    msg:            { type: String, required: true },
    acknowledged:   { type: Boolean, default: false },
    deliveryStatus: { type: String, enum: ['pending', 'websocket', 'fallback-log'], default: 'pending' }
});
```

Explanation:
Notifications are first-class persisted records with type, ownership, acknowledgment, and delivery status. They are the canonical alert model used by parent-facing UI and fallback delivery.

## 3. DEPENDABILITY ANALYSIS

### 3.1 Availability

File: D:/CLMS/CLMS-HK252/server.js and D:/CLMS/CLMS-HK252/services/worker.js

Code:
```js
require('./services/mqttService').init(io);
require('./services/heartbeat').init(io);
require('./services/worker').init(io);
```

```js
async function poll() {
    if (mongoose.connection.readyState !== 1) return;
    const event = await queueService.claimNextPending();
    if (!event) return;
    await processEvent(event);
    setImmediate(poll);
}
```

Explanation:
Availability is PARTIAL. The system keeps dashboards and workers alive in one process and uses background services for live updates, but there is no multi-instance failover, no session store, and no infrastructure HA. A single Node process remains a single point of service failure.

Status: PARTIAL

### 3.2 Reliability

File: D:/CLMS/CLMS-HK252/utils/retry.js and D:/CLMS/CLMS-HK252/services/queueService.js

Code:
```js
async function withRetry(fn, label = 'operation', retries = MAX_RETRIES) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            return await withTimeout(fn(), label, OP_TIMEOUT_MS);
        } catch (err) {
            ...
            if (attempt < retries) await sleep(delay);
        }
    }
    throw lastErr;
}
```

```js
async function enqueue(eventType, payload, maxAttempts = 5) {
    if (mongoose.connection.readyState !== 1) {
        if (memoryBuffer.length < MAX_MEMORY_BUFFER) {
            memoryBuffer.push({ eventType, payload, maxAttempts, bufferedAt: new Date() });
        }
        return null;
    }
    return await PendingEvent.create({ eventType, payload, maxAttempts });
}
```

Explanation:
Reliability is PARTIAL. The code has retries, exponential backoff, timeouts, atomic queue claims, and persistent storage, but critical transient state is still partly in memory. A DB outage can still overflow the memory buffer and drop events.

Status: PARTIAL

### 3.3 Safety

File: D:/CLMS/CLMS-HK252/services/geofence.js and D:/CLMS/CLMS-HK252/utils/validate.js

Code:
```js
if (!isValidCoord(lat, lng)) {
    logger.warn(MOD, `Invalid coordinates from ${childId}: lat=${lat}, lng=${lng}. Discarding.`);
    return;
}
```

```js
if (secondary !== null && primary !== secondary) {
    logger.warn(MOD, ...);
    return false;
}
```

Explanation:
Safety is PARTIAL. The code validates coordinates, rejects malformed MQTT payloads, and fails safe on geofence mismatch. However, there is no cryptographic device attestation for GPS messages and the system still trusts topic-derived child IDs after basic parsing.

Status: PARTIAL

### 3.4 Security

File: D:/CLMS/CLMS-HK252/server.js, D:/CLMS/CLMS-HK252/middleware/csrf.js, D:/CLMS/CLMS-HK252/routes/iot.js

Code:
```js
cookie: {
    maxAge:   3600000,
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'strict'
}
```

```js
if (req.path.startsWith('/iot/')) return next();
```

```js
router.post('/register-secret', async (req, res) => {
    const { childId, deviceSecret } = req.body;
    const parent = await User.findOne({ "linkedDevices.childId": childId });
    ...
});
```

Explanation:
Security is WEAK. Authentication and CSRF are present for the browser app, and login has rate limiting, but `/iot/register-secret` is not protected by a role guard in the current code. In addition, the CSRF bypass for all `/iot/*` routes means the POST protection is not uniform. The session cookie secure flag still follows NODE_ENV instead of the HTTPS toggle, and the server still allows HTTP by default.

Status: WEAK

### 3.5 Resilience

File: D:/CLMS/CLMS-HK252/services/dbService.js and D:/CLMS/CLMS-HK252/services/fallbackNotifier.js

Code:
```js
try {
    const doc = await withRetry(() => History.create(payload), 'history-primary');
    BackupHistory.create({ ...payload, sourceFail: false }).catch(() => {});
    return doc;
} catch (primaryErr) {
    try {
        const doc = await withRetry(() => BackupHistory.create({ ...payload, sourceFail: true }), 'history-backup');
        return doc;
    } catch (backupErr) {
        writeFallbackFile('history', payload);
        return null;
    }
}
```

```js
if (wsOnline) {
    ...
} else {
    const emailSent = simulateEmail(parentUsername, payload);
    if (!emailSent) {
        await queueService.enqueue('notification_retry', { parentUsername, event, payload }, 3);
    }
}
```

Explanation:
Resilience is PARTIAL. The application can survive some DB and delivery failures by falling back across collections, log files, and queue retries, but this is still application-level resilience rather than a distributed resilient deployment.

Status: PARTIAL

## 4. FAILURE HANDLING

### 4.1 Hardware failures

File: D:/CLMS/CLMS-HK252/services/heartbeat.js

Code:
```js
if (elapsed > OFFLINE_THRESHOLD_MS && !device.offlineAlertActive) {
    const msg = `Device "${device.childName}" has not sent a location update for more than 5 minutes. It may be offline or out of coverage.`;
    ...
    await fallbackNotifier.deliverAlert(_io, parent.username, 'device-offline', {
        childId:        device.childId,
        childName:      device.childName,
        parentUsername: parent.username,
        msg,
        type:           'OFFLINE',
        time:           new Date()
    });
}
```

Explanation:
The code handles the practical symptom of device hardware failure by treating silence as offline after 5 minutes. It does not inspect battery health, sensor health, or hardware liveness directly. That means the hardware failure model is inferred from missing telemetry, not from a separate health channel.

### 4.2 Software failures

File: D:/CLMS/CLMS-HK252/utils/retry.js, D:/CLMS/CLMS-HK252/services/mqttService.js, D:/CLMS/CLMS-HK252/utils/validate.js

Code:
```js
return await withTimeout(fn(), label, OP_TIMEOUT_MS);
```

```js
if (!isValidCoord(lat, lng)) {
    logger.warn(MOD, `Invalid coordinates from ${childId}: lat=${lat}, lng=${lng}. Discarding.`);
    return;
}
```

```js
try {
    data = JSON.parse(message.toString());
} catch (_) {
    logger.warn(MOD, `Malformed JSON from ${childId}. Discarding.`);
    return;
}
```

Explanation:
Malformed JSON, invalid coordinates, and slow operations are handled explicitly. The code retries several DB and delivery operations, but software faults that exceed retry limits are not repaired automatically beyond logging and fallback routing.

### 4.3 Operational failures

File: D:/CLMS/CLMS-HK252/services/dbService.js, D:/CLMS/CLMS-HK252/services/queueService.js, D:/CLMS/CLMS-HK252/server.js

Code:
```js
if (!process.env.SESSION_SECRET) {
    logger.warn('SERVER', 'SESSION_SECRET is not set. Using an ephemeral development secret.');
}
```

```js
if (mongoose.connection.readyState !== 1) {
    if (memoryBuffer.length < MAX_MEMORY_BUFFER) {
        memoryBuffer.push({ eventType, payload, maxAttempts, bufferedAt: new Date() });
    }
    return null;
}
```

```js
try {
    return await BackupHistory.find({ childId }).sort({ time: -1 }).limit(limit).lean();
} catch (backupErr) {
    logger.error('DBSVC', `Backup history read also failed for ${childId}: ${backupErr.message}`);
    return [];
}
```

Explanation:
Operational failure handling exists, but it is uneven. DB reads can fall back, writes can cascade through several layers, and sessions emit warnings if secrets are missing. Still, runtime state such as memoryBuffer and session storage is process-local, so a process crash during an outage can drop buffered work.

## 5. REDUNDANCY & DIVERSITY

File: D:/CLMS/CLMS-HK252/services/dbService.js, D:/CLMS/CLMS-HK252/services/queueService.js, D:/CLMS/CLMS-HK252/services/fallbackNotifier.js, D:/CLMS/CLMS-HK252/services/geofence.js

Code:
```js
// Layer 1: Primary MongoDB (History collection)
// Layer 2: BackupHistory collection (same instance, separate collection)
// Layer 3: File-based NDJSON log
```

```js
const memoryBuffer = [];
...
await PendingEvent.create({ eventType, payload, maxAttempts });
```

```js
const emailSent = simulateEmail(parentUsername, payload);
if (!emailSent) {
    await queueService.enqueue('notification_retry', { parentUsername, event, payload }, 3);
}
```

```js
if (secondary !== null && primary !== secondary) {
    return false;
}
```

Explanation:
Redundancy is implemented at application level. Database fallback uses primary collection, backup collection, and file log inside the same application stack. Queue redundancy uses a Mongo collection plus a temporary memory buffer. Alert redundancy uses WebSocket, simulated email log, and retry queue. Algorithm diversity is implemented by comparing primary and secondary geofence algorithms before accepting the result.

## 6. RELIABILITY MECHANISMS

File: D:/CLMS/CLMS-HK252/utils/retry.js, D:/CLMS/CLMS-HK252/utils/validate.js, D:/CLMS/CLMS-HK252/services/worker.js

Code:
```js
async function withRetry(fn, label = 'operation', retries = MAX_RETRIES) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            return await withTimeout(fn(), label, OP_TIMEOUT_MS);
        } catch (err) {
            ...
            if (attempt < retries) await sleep(delay);
        }
    }
    throw lastErr;
}
```

```js
function withTimeout(promise, label, ms) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error(`[Timeout] ${label} exceeded ${ms}ms`)),
            ms
        );
        ...
    });
}
```

```js
async function processEvent(event) {
    if (eventType === 'mqtt_message') {
        await _processMessage(payload.childId, {
            lat:  payload.lat,
            lng:  payload.lng,
            batt: payload.batt || 100
        });
    }
    await queueService.markDone(_id);
}
```

Explanation:
The reliability layer is real and code-backed. Retrying with backoff, hard timeouts, input validation, and atomic queue claims are all present. The worker replays queued MQTT messages and retryable notifications through the same handler path, which preserves behavior consistency across live and replayed events.

## 7. FAULT TOLERANCE

File: D:/CLMS/CLMS-HK252/services/dbService.js, D:/CLMS/CLMS-HK252/services/mqttService.js, D:/CLMS/CLMS-HK252/services/queueService.js

Code:
```js
if (!isDbConnected()) {
    await queueService.enqueue('mqtt_message', { childId, lat, lng, batt });
    logger.warn(MOD, `DB offline. Message from "${childId}" enqueued.`);
    return;
}
```

```js
if (!MQTT_URL || !MQTT_USERNAME || !MQTT_PASSWORD) {
    logger.error(MOD, 'MQTT_URL, MQTT_USERNAME, and MQTT_PASSWORD must be set in the environment. MQTT connection disabled.');
    return;
}
```

```js
const sessionSecret = process.env.SESSION_SECRET || (process.env.NODE_ENV === 'production' ? null : crypto.randomBytes(48).toString('hex'));
```

Explanation:
When the DB fails, the system keeps accepting MQTT data and moves messages into the queue service, but that queue still has a memoryBuffer fallback. When MQTT fails or credentials are missing, the ingestion service is disabled and the dashboard remains but live telemetry stops. On restart, Mongo-backed data survives, but session state, Socket.IO room membership, and any in-memory buffered events are lost.

## 8. SAFETY ANALYSIS

File: D:/CLMS/CLMS-HK252/services/geofence.js, D:/CLMS/CLMS-HK252/utils/validate.js, D:/CLMS/CLMS-HK252/services/heartbeat.js, D:/CLMS/CLMS-HK252/routes/iot.js

Code:
```js
if (!isValidCoord(lat, lng)) {
    logger.warn(MOD, `Invalid coordinates from ${childId}: lat=${lat}, lng=${lng}. Discarding.`);
    return;
}
```

```js
if (secondary !== null && primary !== secondary) {
    logger.warn(MOD, ...);
    return false;
}
```

```js
if (!deviceSecret || deviceSecret.length < 8)
    return res.status(400).send('Invalid deviceSecret');
```

Explanation:
The main hazards are wrong geofence classification, stale or missing location updates, and unauthorized SOS/device configuration. The code mitigates these hazards with coordinate validation, two-algorithm geofence cross-checking, offline detection after a threshold, and secret-length validation for SOS and secret registration. The remaining safety gap is that topic-derived child identity is still trusted after basic parsing, and there is no separate device attestation channel for GPS telemetry.

## 9. SECURITY ANALYSIS

File: D:/CLMS/CLMS-HK252/middleware/auth.js, D:/CLMS/CLMS-HK252/middleware/csrf.js, D:/CLMS/CLMS-HK252/server.js, D:/CLMS/CLMS-HK252/routes/auth.js, D:/CLMS/CLMS-HK252/routes/iot.js

Code:
```js
function requireRole(...roles) {
    return (req, res, next) => {
        if (!req.session?.user) return res.redirect('/login');
        if (!roles.includes(req.session.user.role))
            return res.status(403).send('Access denied.');
        next();
    };
}
```

```js
cookie: {
    maxAge:   3600000,
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'strict'
}
```

```js
if (req.path.startsWith('/iot/')) return next();
```

```js
router.post('/register-secret', async (req, res) => {
    const { childId, deviceSecret } = req.body;
    const parent = await User.findOne({ "linkedDevices.childId": childId });
    ...
});
```

Explanation:
Authentication exists for browser sessions, password checks, and SOS device secrets. Authorization exists for the dashboard and parent routes through requireLogin and requireRole. CSRF exists for most browser POSTs, and login is rate-limited. However, the current code exposes a real weakness because /iot/register-secret is not wrapped in a parent role guard after the recent change. The secure-cookie flag also still tracks NODE_ENV instead of the HTTPS toggle, and the CSRF middleware intentionally bypasses all /iot/* requests. These are code-level security gaps, not theoretical ones.

## 10. GAP ANALYSIS

### 10.1 No durable session store

File: D:/CLMS/CLMS-HK252/server.js

Code:
```js
const sessionMiddleware = session({
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: { ... }
});
```

Explanation:
No `store` option is configured. Session state remains process-local and is not preserved independently of the Node process.

### 10.2 In-memory queue buffer still exists

File: D:/CLMS/CLMS-HK252/services/queueService.js

Code:
```js
const memoryBuffer = [];
if (memoryBuffer.length < MAX_MEMORY_BUFFER) {
    memoryBuffer.push({ eventType, payload, maxAttempts, bufferedAt: new Date() });
}
```

Explanation:
The queue survives normal processing failures, but DB outages still rely on an in-memory buffer that can be lost on crash or overflow.

### 10.3 MQTT device identity is not cryptographically attested per message

File: D:/CLMS/CLMS-HK252/services/mqttService.js

Code:
```js
const parts   = topic.split('/');
const childId = parts[parts.length - 1];
...
const parents = await withRetry(
    () => User.find({ role: 'parent', 'linkedDevices.childId': childId }),
    'parent lookup'
);
```

Explanation:
The MQTT message is trusted once the topic suffix is parsed and ownership is found. There is no per-message signature or HMAC-style attestation in the code.

### 10.4 Secret-registration route is missing role protection

File: D:/CLMS/CLMS-HK252/routes/iot.js

Code:
```js
const { requireRole } = require('../middleware/auth');

router.post('/register-secret', async (req, res) => {
    ...
});
```

Explanation:
The guard is imported but not applied. Any client that can reach the route can attempt to update a linked device secret if it knows the childId.

### 10.5 Simulated email is not a real delivery channel

File: D:/CLMS/CLMS-HK252/services/fallbackNotifier.js

Code:
```js
function simulateEmail(parentUsername, payload) {
    ...
    fs.appendFileSync(SIMULATED_EMAIL_FILE, record + '\n');
}
```

Explanation:
The fallback channel is a file append, not SMTP, push, or SMS. It is a placeholder delivery path, not a production notification subsystem.

### 10.6 HTTPS is opt-in, not default

File: D:/CLMS/CLMS-HK252/server.js

Code:
```js
const useHttps = /^(true|1)$/i.test(String(process.env.ENABLE_HTTPS || ''));
...
if (!useHttps) {
    logger.warn('SERVER', 'Running in HTTP mode. Set ENABLE_HTTPS=true with HTTPS_KEY_PATH and HTTPS_CERT_PATH for production.');
}
```

Explanation:
The server still starts in HTTP mode unless explicitly toggled. That means transport security is not enforced by default.

### 10.7 Login and register pages are synchronously read on each request

File: D:/CLMS/CLMS-HK252/routes/auth.js

Code:
```js
const html = fs.readFileSync(path.join(__dirname, '..', 'views', 'login.html'), 'utf8')
    .replaceAll('{{CSRF_TOKEN}}', req.session?.csrfToken || '');
```

Explanation:
This adds synchronous disk I/O to request handling for the login and register pages. It is not a functional bug, but it is a maintainability and latency gap.

## 11. CODE VS THEORY

### 11.1 Claim: zero in-memory critical state

File: D:/CLMS/CLMS-HK252/README.md and D:/CLMS/CLMS-HK252/services/queueService.js

Code:
```md
State Persistence: Geofence states and last-seen timestamps are strictly persisted to the database. The system relies on zero in-memory critical state, allowing it to survive unexpected server restarts.
```

```js
const memoryBuffer = [];
if (mongoose.connection.readyState !== 1) {
    memoryBuffer.push({ eventType, payload, maxAttempts, bufferedAt: new Date() });
}
```

Explanation:
The README claims zero in-memory critical state, but the code still uses memoryBuffer for DB outage periods. That means restart resilience is incomplete.

### 11.2 Claim: alerts are never lost during database outages

File: D:/CLMS/CLMS-HK252/README.md and D:/CLMS/CLMS-HK252/services/fallbackNotifier.js

Code:
```md
If the primary database goes offline, the system utilizes an in-memory buffer to queue incoming MQTT traffic, migrating it to the persistent queue upon reconnection.
```

```js
const emailSent = simulateEmail(parentUsername, payload);
if (!emailSent) {
    await queueService.enqueue('notification_retry', { parentUsername, event, payload }, 3);
}
```

Explanation:
The theory says alerts are guaranteed, but the real implementation still depends on a simulated email log and in-memory buffering. That is a fallback chain, not a hard guarantee.

### 11.3 Claim: secure access and role-based device controls

File: D:/CLMS/CLMS-HK252/README.md and D:/CLMS/CLMS-HK252/routes/iot.js

Code:
```md
Device Authentication: IoT endpoints utilize a secure, pre-shared deviceSecret validated via bcrypt hashing to prevent unauthorized access to the SOS API.
```

```js
router.post('/register-secret', async (req, res) => {
    const { childId, deviceSecret } = req.body;
    const parent = await User.findOne({ "linkedDevices.childId": childId });
});
```

Explanation:
SOS authentication exists, but the secret-registration endpoint is not guarded by a parent role check in code. The security story in documentation is therefore broader than the actual enforcement.

### 11.4 Claim: production secure cookies with HTTPS-only transmission

File: D:/CLMS/CLMS-HK252/README.md and D:/CLMS/CLMS-HK252/server.js

Code:
```md
Session Security: Session cookies are hardened using httpOnly and sameSite attributes, with production configurations enforcing secure (HTTPS-only) transmission.
```

```js
cookie: {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'strict'
}
```

Explanation:
The code does harden cookies, but `secure` is tied to NODE_ENV rather than the HTTPS toggle. The promise in the README is directionally correct, but the implementation is weaker and environment-dependent.

## 12. FINAL VERDICT

File: D:/CLMS/CLMS-HK252/server.js, D:/CLMS/CLMS-HK252/services/dbService.js, D:/CLMS/CLMS-HK252/services/queueService.js, D:/CLMS/CLMS-HK252/routes/iot.js

Code:
```js
app.use(ensureCsrfToken);
app.use(verifyCsrf);
...
require('./services/mqttService').init(io);
require('./services/heartbeat').init(io);
require('./services/worker').init(io);
```

```js
const memoryBuffer = [];
...
function simulateEmail(parentUsername, payload) {
    fs.appendFileSync(SIMULATED_EMAIL_FILE, record + '\n');
}
```

```js
router.post('/register-secret', async (req, res) => {
    const { childId, deviceSecret } = req.body;
    const parent = await User.findOne({ "linkedDevices.childId": childId });
});
```

Explanation:
The code reaches Advanced Academic level, not production-ready. It demonstrates real dependability engineering: retries, timeouts, persistent queueing, backup collections, fail-safe geofence logic, session auth, CSRF tokens, and multi-channel alert delivery. What blocks production readiness is the remaining process-local state, simulated fallback delivery, opt-in HTTPS, no durable session store, and the missing role guard on /iot/register-secret.
