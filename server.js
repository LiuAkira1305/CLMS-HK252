require('dotenv').config();

// server.js — Entry point. Initialisation only. No business logic here.
const express    = require('express');
const http       = require('http');
const https      = require('https');
const fs         = require('fs');
const crypto     = require('crypto');
const { Server } = require('socket.io');
const session    = require('express-session');
const bodyParser = require('body-parser');
const rateLimit  = require('express-rate-limit');
// REDUNDANCY: structured logger and instance ID
const logger = require('./utils/logger');
const { ensureCsrfToken, verifyCsrf } = require('./middleware/csrf');

// ─── 1. DATABASE CONNECTION ───────────────────────────────────────────────────
require('./db.js');

// ─── 2. EXPRESS APP & HTTP SERVER ─────────────────────────────────────────────
const app    = express();
const useHttps = /^(true|1)$/i.test(String(process.env.ENABLE_HTTPS || ''));
const server = createServer(app, useHttps);
const io     = new Server(server);
const PORT   = process.env.PORT || 3000;
const sessionSecret = process.env.SESSION_SECRET || (process.env.NODE_ENV === 'production' ? null : crypto.randomBytes(48).toString('hex'));
if (useHttps || process.env.NODE_ENV === 'production') {
    app.set('trust proxy', 1);
}

// ─── 3. MIDDLEWARE ────────────────────────────────────────────────────────────
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

if (!process.env.SESSION_SECRET) {
    logger.warn('SERVER', 'SESSION_SECRET is not set. Using an ephemeral development secret.');
}
if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
    logger.error('SERVER', 'SESSION_SECRET must be set in production.');
}

const sessionMiddleware = session({
    secret:            sessionSecret,
    resave:            false,
    saveUninitialized: false,
    // FIX: HTTPS-ready cookie config — set httpOnly to prevent JS access;
    //      set secure:true when behind a TLS proxy in production.
    cookie: {
        maxAge:   3600000,     // 1 hour
        httpOnly: true,        // Prevents JS-based session hijacking
        secure:   useHttps,    // Follows runtime HTTPS toggle
        sameSite: 'strict'     // Mitigates CSRF
    }
});

app.use(sessionMiddleware);
app.use(ensureCsrfToken);
app.use(verifyCsrf);

// FIX: rate limit on /iot/sos — prevents SOS spam/abuse
const sosLimiter = rateLimit({
    windowMs:        60 * 1000,    // 1 minute window
    max:             5,             // Max 5 SOS per device per minute
    standardHeaders: true,
    legacyHeaders:   false,
    message:         JSON.stringify({ error: 'Too many SOS requests. Try again later.' })
});
app.use('/iot/sos', sosLimiter);

const iotLimiter = rateLimit({
    windowMs:        60 * 1000,
    max:             30,
    standardHeaders: true,
    legacyHeaders:   false
});
app.use('/iot', iotLimiter);

// Expose io to route handlers via req.app.get('io')
app.set('io', io);

// ─── 4. SOCKET.IO — PARENT ROOM MANAGEMENT ───────────────────────────────────
// Each parent joins their own private room to receive isolated events.
// Room name format: "parent:<username>"
io.use((socket, next) => sessionMiddleware(socket.request, {}, next));
io.use((socket, next) => {
    const user = socket.request.session?.user;
    if (!user) return next(new Error('unauthorized'));
    socket.data.user = user;
    next();
});

io.on('connection', (socket) => {
    const user = socket.data.user;
    if (user?.role === 'parent') {
        socket.join(`parent:${user.username}`);
        console.log(`[Socket] ${socket.id} joined room parent:${user.username}`);
    }

    socket.on('disconnect', () => {
        console.log(`[Socket] Disconnected: ${socket.id}`);
    });
});

app.post('/test', (req, res) => {
    return res.json({ ok: true });
});

// ─── 5. ROUTES ────────────────────────────────────────────────────────────────
app.use('/iot',     require('./routes/iot'));
app.use('/admin',   require('./routes/admin'));
app.use('/parent',  require('./routes/parent'));
app.use('/',        require('./routes/auth'));
app.use('/',        require('./routes/dashboard'));

// ─── 6. SERVICES ─────────────────────────────────────────────────────────────
// Started AFTER routes are registered so io is fully initialised.
require('./services/mqttService').init(io);
require('./services/heartbeat').init(io);

// REDUNDANCY: durable queue worker started
require('./services/worker').init(io);

// ─── 7. GLOBAL FAULT ISOLATION ───────────────────────────────────────────────
// FIX: prevent unhandled rejections from crashing the process silently.
process.on('unhandledRejection', (reason, promise) => {
    console.error('[Process] Unhandled Promise Rejection:', reason);
});

process.on('uncaughtException', (err) => {
    console.error('[Process] Uncaught Exception — server will attempt to continue:', err.message);
    // Note: in production, a process manager (PM2) should restart on fatal errors.
});

// ─── 8. START SERVER ─────────────────────────────────────────────────────────
server.listen(PORT, () => {
    logger.info('SERVER', useHttps ? `CLMS running over HTTPS on port ${PORT}` : `CLMS running at http://localhost:${PORT}`);
    logger.info('SERVER', `NODE_ENV=${process.env.NODE_ENV || 'development'} | INSTANCE=${logger.INSTANCE_ID}`);
    if (!useHttps) {
        logger.warn('SERVER', 'Running in HTTP mode. Set ENABLE_HTTPS=true with HTTPS_KEY_PATH and HTTPS_CERT_PATH for production.');
    }
});

function createServer(appInstance, enableHttps) {
    if (!enableHttps) {
        return http.createServer(appInstance);
    }

    const keyPath = process.env.HTTPS_KEY_PATH;
    const certPath = process.env.HTTPS_CERT_PATH;
    if (!keyPath || !certPath || !fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
        logger.warn('SERVER', 'HTTPS requested but key/cert paths are missing or unreadable. Falling back to HTTP.');
        return http.createServer(appInstance);
    }

    logger.info('SERVER', 'HTTPS enabled via environment toggle.');
    return https.createServer({
        key: fs.readFileSync(keyPath),
        cert: fs.readFileSync(certPath),
        passphrase: process.env.HTTPS_PASSPHRASE || undefined
    }, appInstance);
}
