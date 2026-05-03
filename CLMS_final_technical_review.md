1. SYSTEM OVERVIEW

File: D:/CLMS/CLMS-HK252/server.js
Code evidence:
    app.use(sessionMiddleware);
    app.use(ensureCsrfToken);
    app.use(verifyCsrf);
    require('./services/mqttService').init(io);
    require('./services/heartbeat').init(io);
    require('./services/worker').init(io);

File: D:/CLMS/CLMS-HK252/services/mqttService.js
Code evidence:
    mqttClient.on('message', async (topic, message) => {
        const childId = parts[parts.length - 1];
        if (!isValidCoord(lat, lng)) return;
        await processMessage(childId, { lat, lng, batt });
    });

The runtime is a single event pipeline, not a set of loosely coupled distributed services. Web requests are authenticated and rendered through Express, while telemetry enters through MQTT, is parsed, validated, and then pushed into persistence, heartbeat tracking, geofence evaluation, and alert delivery. This matters because the system’s behavior depends on ordered processing inside one process: when one stage fails, later stages are still expected to continue or degrade gracefully.

The data flow is end-to-end and stateful. A child device publish becomes a parent-owned record, then becomes a history entry, a live Socket.IO update, a geofence decision, and possibly an alert notification. The architecture therefore proves a practical dependability design, but it also means the system is only as strong as the runtime sequencing and fallback logic in each service.

2. ARCHITECTURE SUMMARY

Server layer
File: D:/CLMS/CLMS-HK252/server.js
Code evidence:
    const server = createServer(app, useHttps);
    const io = new Server(server);
    app.use(sessionMiddleware);

The server layer is the orchestration point. It decides transport mode, session policy, CSRF enforcement, Socket.IO binding, rate limits, and service startup order. This matters because the whole dependability model is activated here; if the server layer is misconfigured, the downstream services cannot compensate for missing session state or missing transport security.

Routing layer
File: D:/CLMS/CLMS-HK252/routes/parent.js
Code evidence:
    router.use(requireRole('parent'));
    router.post('/set-geofence', async (req, res) => {
        ...
    });

The routing layer expresses application intent: parent account actions, geofence changes, notifications, and history queries. Its role is important because this is where ownership checks and user-facing mutations are enforced. The design is modular, but the route files still mix rendering, validation, and state updates, so the structure is separated by feature rather than by strict service boundaries.

Service layer
File: D:/CLMS/CLMS-HK252/services/dbService.js
Code evidence:
    const doc = await withRetry(() => History.create(payload), 'history-primary');
    BackupHistory.create({ ...payload, sourceFail: false }).catch(() => {});
    writeFallbackFile('history', payload);

The service layer contains the real dependability logic. It is where retries, fallback writes, queueing, alert fanout, and geofence diversity checks live. This matters because the system’s quality is not defined by route handlers alone; its resilience and fault handling are encoded in these services, so service correctness directly determines whether data is preserved under failure.

Data layer
File: D:/CLMS/CLMS-HK252/models/User.js
Code evidence:
    deviceSecret: { type: String, default: null },
    geofenceState: { type: Boolean, default: null },
    lastSeen:     { type: Date, default: null },
    offlineAlertActive: { type: Boolean, default: false },

The data layer stores both identity and operational device state inside the user aggregate. That matters because the system’s recovery behavior depends on these fields surviving restarts. The design is practical for ownership checks, but it also concentrates multiple concerns into one document, which increases coupling between account management and runtime telemetry state.

3. DEPENDABILITY ANALYSIS

Availability: Status PARTIAL
File: D:/CLMS/CLMS-HK252/server.js and D:/CLMS/CLMS-HK252/services/worker.js
Code evidence:
    const useHttps = /^(true|1)$/i.test(String(process.env.ENABLE_HTTPS || ''));
    if (!useHttps) {
        logger.warn('SERVER', 'Running in HTTP mode...');
    }
    if (mongoose.connection.readyState !== 1) return;

Availability is improved by the fact that the app keeps the web dashboard, MQTT ingestion, heartbeat, and queue worker alive in the same runtime. That improves partial service continuity during some failures. However, availability is still limited by single-process deployment, a single MongoDB instance, and a single MQTT broker. The code does not provide infrastructure redundancy, so the system can degrade gracefully but not remain highly available under host-level failure.

Reliability: Status PARTIAL
File: D:/CLMS/CLMS-HK252/utils/retry.js and D:/CLMS/CLMS-HK252/services/queueService.js
Code evidence:
    return await withTimeout(fn(), label, OP_TIMEOUT_MS);
    if (memoryBuffer.length < MAX_MEMORY_BUFFER) {
        memoryBuffer.push({ eventType, payload, maxAttempts, bufferedAt: new Date() });
    }

Reliability is one of the better-implemented qualities in the system. Retries, backoff, timeouts, queue replay, and validation all reduce the chance that transient faults become permanent data loss. The limitation is that a DB outage still relies on an in-memory buffer, so reliability is strong against short interruptions but not guaranteed across long outages or process restarts.

Safety: Status PARTIAL
File: D:/CLMS/CLMS-HK252/services/geofence.js and D:/CLMS/CLMS-HK252/utils/validate.js
Code evidence:
    if (!isValidCoord(lat, lng)) {
        logger.warn(MOD, `Invalid coordinates...`);
        return;
    }
    if (secondary !== null && primary !== secondary) {
        return false;
    }

Safety is implemented where it matters most: bad coordinates are rejected before classification, and mismatched geofence algorithms fail closed by treating the point as outside. This matters because the dangerous outcome is not merely a wrong UI state; it is a false safe-zone decision that could suppress a real alert. The remaining limitation is that the system still trusts topic-derived identity after parsing, so telemetry authenticity is not fully defended at the message level.

Security: Status PARTIAL
File: D:/CLMS/CLMS-HK252/middleware/auth.js, D:/CLMS/CLMS-HK252/middleware/csrf.js, D:/CLMS/CLMS-HK252/routes/iot.js
Code evidence:
    if (!req.session?.user) return res.redirect('/login');
    if (!roles.includes(req.session.user.role)) return res.status(403).send('Access denied.');
    if (req.path === '/iot/sos') return next();
    router.post('/register-secret', requireRole('parent'), async (req, res) => {

Security is meaningfully implemented, but not fully hardened. Browser sessions are protected by login and role checks, most POSTs are protected by CSRF, and device secrets are bcrypt-hashed. The risk is that the protection model is not uniform: SOS is deliberately exempted from CSRF, and the MQTT path still relies on broker/topic trust rather than signed telemetry. So the code has real security controls, but they are selective and context-specific.

Resilience: Status PARTIAL
File: D:/CLMS/CLMS-HK252/services/dbService.js and D:/CLMS/CLMS-HK252/services/fallbackNotifier.js
Code evidence:
    BackupHistory.create({ ...payload, sourceFail: false }).catch(() => {});
    writeFallbackFile('history', payload);
    const emailSent = simulateEmail(parentUsername, payload);
    await queueService.enqueue('notification_retry', { parentUsername, event, payload }, 3);

Resilience is implemented as staged degradation rather than true distributed failover. The system can survive some write failures by moving from primary collections to backups, then to file logs, and from WebSocket to simulated email to retry queue. That improves fault tolerance at the application layer, but it still does not protect against host failure, broker failure, or long-running infrastructure outages.

4. FAILURE HANDLING

Invalid input
File: D:/CLMS/CLMS-HK252/utils/validate.js and D:/CLMS/CLMS-HK252/routes/iot.js
Code evidence:
    if (!isValidCoord(lat, lng)) return;
    if (!deviceSecret || deviceSecret.length < 8)
        return res.status(400).send('Invalid deviceSecret');

Invalid input is rejected early rather than being corrected or tolerated. That matters because garbage coordinates or malformed secrets would not just break a request; they would contaminate location history, geofence logic, and SOS authentication. The code protects the downstream pipeline by stopping bad input at the boundary.

Service failure
File: D:/CLMS/CLMS-HK252/services/dbService.js and D:/CLMS/CLMS-HK252/utils/retry.js
Code evidence:
    const doc = await withRetry(() => History.create(payload), 'history-primary');
    const doc = await withRetry(() => BackupHistory.create({ ...payload, sourceFail: true }), 'history-backup');
    writeFallbackFile('history', payload);

Service failure is handled through fallback progression, not immediate abort. If the primary DB path fails, the system retries, then falls back to backup storage, then logs to file. This improves fault tolerance because the application preserves observability and recoverability even when the ideal write path is unavailable. The tradeoff is that the quality of persistence degrades across layers, so the system favors continuity over perfect storage semantics.

Offline device
File: D:/CLMS/CLMS-HK252/services/heartbeat.js
Code evidence:
    if (elapsed > OFFLINE_THRESHOLD_MS && !device.offlineAlertActive) {
        await User.updateOne(...);
        await fallbackNotifier.deliverAlert(_io, parent.username, 'device-offline', ...);
    }

Offline handling is threshold-based and stateful. If no GPS update arrives within the timeout window, the device is treated as a safety concern and an OFFLINE alert is emitted. This matters because the system is not only tracking location; it is also monitoring liveness. Persisting the offline flag reduces duplicate alerts after restart and makes the offline condition part of the stored state, not just a transient runtime observation.

5. REDUNDANCY & DIVERSITY

File: D:/CLMS/CLMS-HK252/services/dbService.js, D:/CLMS/CLMS-HK252/services/fallbackNotifier.js, D:/CLMS/CLMS-HK252/services/geofence.js, D:/CLMS/CLMS-HK252/services/queueService.js
Code evidence:
    BackupHistory.create({ ...payload, sourceFail: false }).catch(() => {});
    writeFallbackFile('history', payload);
    const emailSent = simulateEmail(parentUsername, payload);
    await queueService.enqueue('notification_retry', { parentUsername, event, payload }, 3);
    if (secondary !== null && primary !== secondary) return false;

Redundancy is implemented primarily at the application level. The system duplicates work across primary and backup collections, queue and memory buffer, WebSocket and simulated email, and primary and secondary geofence algorithms. This is valuable because it prevents single-path failure from stopping the system immediately. The limitation is that every redundant path still depends on the same application and usually the same MongoDB instance, so the redundancy is functional rather than infrastructural.

What is still missing is true deployment-level redundancy. There is no separate broker, no secondary application node, and no independent storage tier in the code. That means redundancy improves behavior under partial faults, but it does not protect the system from a full runtime or host failure.

6. RELIABILITY MECHANISMS

File: D:/CLMS/CLMS-HK252/utils/retry.js and D:/CLMS/CLMS-HK252/services/worker.js
Code evidence:
    return await withTimeout(fn(), label, OP_TIMEOUT_MS);
    if (attempt < retries) await sleep(delay);
    const event = await queueService.claimNextPending();
    await processEvent(event);

Retry and timeout increase reliability by converting uncertain operations into bounded attempts. That matters because transient failures are expected in a live tracking system: database latency, notification delays, and temporary connection loss should not derail the full pipeline. Queue claiming and worker replay further improve reliability because they decouple receipt from processing, letting the system absorb bursts and delayed work instead of forcing synchronous success.

File: D:/CLMS/CLMS-HK252/utils/validate.js
Code evidence:
    Number.isFinite(lat) && lat >= -90 && lat <= 90
    Number.isFinite(lng) && lng >= -180 && lng <= 180

Validation improves reliability because it prevents invalid data from entering retry or persistence logic in the first place. This reduces failure amplification: a malformed coordinate cannot create a bad history record, a corrupted geofence decision, or an alert chain triggered by nonsense input.

7. FAULT TOLERANCE

DB fails
File: D:/CLMS/CLMS-HK252/services/mqttService.js and D:/CLMS/CLMS-HK252/services/queueService.js
Code evidence:
    if (!isDbConnected()) {
        await queueService.enqueue('mqtt_message', { childId, lat, lng, batt });
        return;
    }

When DB connectivity is lost, telemetry is not immediately discarded. It is diverted into the queue service, which first tries Mongo-backed persistence and then falls back to the memory buffer if necessary. This improves fault tolerance because the ingest path can remain live while persistence is degraded. The risk is that the memory buffer is not durable, so very long outages or a restart can still lose buffered events.

MQTT fails
File: D:/CLMS/CLMS-HK252/services/mqttService.js
Code evidence:
    if (!MQTT_URL || !MQTT_USERNAME || !MQTT_PASSWORD) {
        logger.error(MOD, 'MQTT_URL, MQTT_USERNAME, and MQTT_PASSWORD must be set in the environment. MQTT connection disabled.');
        return;
    }

If MQTT configuration is missing, the system stops ingestion cleanly and logs the reason. That is a limited form of fault tolerance: the dashboard still runs, but live tracking cannot recover on its own because there is no alternate broker or transport path. The design contains the failure, but does not heal it.

System restarts
File: D:/CLMS/CLMS-HK252/models/User.js and D:/CLMS/CLMS-HK252/services/queueService.js
Code evidence:
    offlineAlertActive: { type: Boolean, default: false },
    offlineAlertAt:     { type: Date, default: null },
    const memoryBuffer = [];

After restart, persisted device state survives because it is stored in MongoDB. That improves continuity for geofence, last-seen, and offline-alert state. However, transient runtime structures do not survive: the memory buffer is lost, Socket.IO room membership must be re-established, and session durability depends on process-local session storage. So restart tolerance is partial, not complete.

8. SAFETY ANALYSIS

File: D:/CLMS/CLMS-HK252/services/geofence.js and D:/CLMS/CLMS-HK252/utils/validate.js
Code evidence:
    if (!isValidCoord(lat, lng)) return;
    if (secondary !== null && primary !== secondary) {
        return false;
    }

The main safety hazard is incorrect zone classification. The code mitigates that by rejecting invalid coordinates and failing safe on algorithm mismatch. This matters because the unsafe outcome is not a technical exception but a user-visible trust error: a child could be shown as inside a safe area when the system is uncertain. Returning outside on disagreement is the safer choice because it prioritizes alert sensitivity over false reassurance.

File: D:/CLMS/CLMS-HK252/services/heartbeat.js
Code evidence:
    if (elapsed > OFFLINE_THRESHOLD_MS && !device.offlineAlertActive) {
        ...
    }

Offline detection is another safety control. It treats silence as potentially unsafe and converts it into a persistent OFFLINE signal. The code also suppresses duplicates through stored state, which matters because repeated false alarms would reduce trust in the safety system even if the first alert was correct.

9. SECURITY ANALYSIS

Authentication
File: D:/CLMS/CLMS-HK252/middleware/auth.js and D:/CLMS/CLMS-HK252/routes/iot.js
Code evidence:
    if (!req.session?.user) return res.redirect('/login');
    const secretMatch = await bcrypt.compare(String(deviceSecret), device.deviceSecret);

Authentication is implemented for the browser and device layers. Session-based auth prevents anonymous dashboard access, and bcrypt comparison prevents plain-text SOS secrets from being accepted directly. This improves access control because the code does not treat credentials as strings to be trusted blindly.

Authorization
File: D:/CLMS/CLMS-HK252/middleware/auth.js and D:/CLMS/CLMS-HK252/routes/iot.js
Code evidence:
    if (!roles.includes(req.session.user.role)) return res.status(403).send('Access denied.');
    router.post('/register-secret', requireRole('parent'), async (req, res) => {
        const parent = await User.findOne({
            username: req.session.user.username,
            "linkedDevices.childId": childId
        });

Authorization is enforced where ownership matters most. The register-secret route now binds the request to the session user and the linked device, which prevents device takeover by another parent who merely knows a childId. This is a meaningful hardening step because it closes the path where ownership and identity could otherwise diverge.

CSRF
File: D:/CLMS/CLMS-HK252/middleware/csrf.js
Code evidence:
    if (req.method !== 'POST') return next();
    if (req.path === '/iot/sos') return next();
    const submitted = req.body?._csrf || req.get('x-csrf-token');

CSRF protection is implemented for browser POSTs, and that improves security for form submissions and AJAX mutations. The explicit bypass for /iot/sos shows that the code separates browser-originated writes from device-originated writes, which is appropriate in principle. The risk is that this makes the CSRF model conditional rather than universal, so the protection depends on endpoint classification being correct.

Device security
File: D:/CLMS/CLMS-HK252/routes/iot.js and D:/CLMS/CLMS-HK252/models/User.js
Code evidence:
    if (!deviceSecret || deviceSecret.length < 8)
        return res.status(400).send('Invalid deviceSecret');
    device.deviceSecret = hash;

Device security is stronger than a simple demo because secrets are validated, hashed, and stored per linked device. The ownership check on register-secret matters because it prevents one parent from overwriting another parent’s device secret. The remaining limitation is that MQTT telemetry still depends on topic identity and broker trust; that leaves a trust gap at the transport layer.

10. GAP ANALYSIS

Gap 1
File: D:/CLMS/CLMS-HK252/server.js
Code reference:
    const sessionMiddleware = session({ secret: sessionSecret, ... });

Explanation:
No durable session store is configured. Why it matters: session state is still tied to the Node process model, so restart or scale-out can break the login state and weaken availability.

Gap 2
File: D:/CLMS/CLMS-HK252/services/queueService.js
Code reference:
    const memoryBuffer = [];

Explanation:
An in-memory queue fallback still exists. Why it matters: buffered MQTT events can be lost during a long outage or process crash, which limits the durability story.

Gap 3
File: D:/CLMS/CLMS-HK252/services/mqttService.js
Code reference:
    const childId = parts[parts.length - 1];
    const parents = await withRetry(() => User.find({ role: 'parent', 'linkedDevices.childId': childId }), 'parent lookup');

Explanation:
Telemetry identity is still derived from the topic suffix and ownership lookup, not from signed payloads. Why it matters: that limits trust in the device-to-server channel and leaves the system dependent on broker/topic correctness.

Gap 4
File: D:/CLMS/CLMS-HK252/services/fallbackNotifier.js
Code reference:
    function simulateEmail(parentUsername, payload) { ... fs.appendFileSync(SIMULATED_EMAIL_FILE, record + '\n'); }

Explanation:
The fallback alert channel is simulated, not operational. Why it matters: the fallback improves dependability in the project sense, but it does not provide production-grade notification delivery.

Gap 5
File: D:/CLMS/CLMS-HK252/middleware/csrf.js
Code reference:
    if (req.path === '/iot/sos') return next();

Explanation:
CSRF is intentionally bypassed for SOS. Why it matters: this is acceptable for a device endpoint, but it means the protection model depends on endpoint classification and is therefore not globally uniform.

Gap 6
File: D:/CLMS/CLMS-HK252/server.js
Code reference:
    const useHttps = /^(true|1)$/i.test(String(process.env.ENABLE_HTTPS || ''));
    if (!useHttps) logger.warn(...);

Explanation:
HTTPS remains opt-in. Why it matters: transport security depends on deployment configuration rather than on secure defaults, which limits the system’s security baseline.

Gap 7
File: D:/CLMS/CLMS-HK252/routes/auth.js
Code reference:
    fs.readFileSync(path.join(__dirname, '..', 'views', 'login.html'), 'utf8')

Explanation:
Login and register pages are read synchronously on each request. Why it matters: this is not a correctness bug, but it adds avoidable latency and blocks the event loop during authentication traffic.

11. CODE VS THEORY

Claim in README
File: D:/CLMS/CLMS-HK252/README.md
Code evidence:
    State Persistence: Geofence states and last-seen timestamps are strictly persisted to the database.
    The system relies on zero in-memory critical state

Actual code
File: D:/CLMS/CLMS-HK252/services/queueService.js
Code evidence:
    const memoryBuffer = [];
    if (mongoose.connection.readyState !== 1) {
        memoryBuffer.push({ eventType, payload, maxAttempts, bufferedAt: new Date() });
    }

The documentation claims zero in-memory critical state, but the code still uses a memory buffer during DB outages. That does not make the design incorrect, but it does mean the theory overstates durability. The implementation is better described as mostly persistent with a temporary volatile escape path.

Claim in README
File: D:/CLMS/CLMS-HK252/README.md
Code evidence:
    Session cookies are hardened using httpOnly and sameSite attributes, with production configurations enforcing secure

Actual code
File: D:/CLMS/CLMS-HK252/server.js
Code evidence:
    secure:   useHttps,
    sameSite: 'strict'

The code does harden cookies, but the secure flag follows the HTTPS toggle rather than an unconditional production policy. This improves accuracy in deployment behavior, but it also means the documentation should describe the condition precisely instead of implying an automatic guarantee.

Claim in README
File: D:/CLMS/CLMS-HK252/README.md
Code evidence:
    Device Authentication: IoT endpoints utilize a secure, pre-shared deviceSecret validated via bcrypt hashing

Actual code
File: D:/CLMS/CLMS-HK252/routes/iot.js
Code evidence:
    router.post('/register-secret', requireRole('parent'), async (req, res) => {
        const parent = await User.findOne({
            username: req.session.user.username,
            "linkedDevices.childId": childId
        });

The authentication claim is broadly true, but the code shows that device security also depends on ownership scoping at the register-secret route. That means the implementation is stronger than a simple “bcrypt secret” description and should be reported as a combined secret-plus-ownership control.

12. FINAL VERDICT

File: D:/CLMS/CLMS-HK252/server.js, D:/CLMS/CLMS-HK252/services/mqttService.js, D:/CLMS/CLMS-HK252/services/dbService.js
Code evidence:
    require('./services/mqttService').init(io);
    require('./services/heartbeat').init(io);
    require('./services/worker').init(io);
    await withRetry(() => History.create(payload), 'history-primary');

The system is best classified as Advanced Academic. That classification is justified because the implementation is not just feature-complete; it contains real dependability mechanisms: retries, timeouts, queue replay, backup persistence, offline persistence, CSRF, session auth, role checks, and geofence fail-safe logic. Those are the kinds of mechanisms that support an academic dependability argument with code-backed evidence.

It is not production-ready. The remaining risks are structural: no durable session store, opt-in HTTPS, simulated fallback email, in-memory buffering during outages, and broker/topic-based identity trust for telemetry. These limitations do not invalidate the design, but they do define the ceiling of the system’s readiness and prevent a production-grade claim.
