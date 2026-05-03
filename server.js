// server.js — Entry point. Initialisation only. No business logic here.
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const session    = require('express-session');
const bodyParser = require('body-parser');
const rateLimit  = require('express-rate-limit');
// REDUNDANCY: structured logger and instance ID
const logger = require('./utils/logger');

// ─── 1. DATABASE CONNECTION ───────────────────────────────────────────────────
require('./db.js');

// ─── 2. EXPRESS APP & HTTP SERVER ─────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server);
const PORT   = process.env.PORT || 3000;

// ─── 3. MIDDLEWARE ────────────────────────────────────────────────────────────
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

app.use(session({
    secret:            process.env.SESSION_SECRET || 'clms_hk252_group3_secret',
    resave:            false,
    saveUninitialized: false,
    // FIX: HTTPS-ready cookie config — set httpOnly to prevent JS access;
    //      set secure:true when behind a TLS proxy in production.
    cookie: {
        maxAge:   3600000,     // 1 hour
        httpOnly: true,        // Prevents JS-based session hijacking
        secure:   process.env.NODE_ENV === 'production', // true in prod (HTTPS only)
        sameSite: 'strict'     // Mitigates CSRF
    }
}));

// FIX: rate limit on /iot/sos — prevents SOS spam/abuse
const sosLimiter = rateLimit({
    windowMs:        60 * 1000,    // 1 minute window
    max:             5,             // Max 5 SOS per device per minute
    standardHeaders: true,
    legacyHeaders:   false,
    message:         JSON.stringify({ error: 'Too many SOS requests. Try again later.' })
});
app.use('/iot/sos', sosLimiter);

// Expose io to route handlers via req.app.get('io')
app.set('io', io);

// ─── 4. SOCKET.IO — PARENT ROOM MANAGEMENT ───────────────────────────────────
// Each parent joins their own private room to receive isolated events.
// Room name format: "parent:<username>"
io.on('connection', (socket) => {
    socket.on('join-parent-room', (username) => {
        if (typeof username === 'string' && username.length > 0) {
            socket.join(`parent:${username}`);
            console.log(`[Socket] ${socket.id} joined room parent:${username}`);
        }
    });

    socket.on('disconnect', () => {
        console.log(`[Socket] Disconnected: ${socket.id}`);
    });
});

// ─── 5. ROUTES ────────────────────────────────────────────────────────────────
app.use('/',        require('./routes/dashboard'));
app.use('/',        require('./routes/auth'));
app.use('/admin',   require('./routes/admin'));
app.use('/parent',  require('./routes/parent'));
app.use('/iot',     require('./routes/iot'));

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
    logger.info('SERVER', `CLMS running at http://localhost:${PORT}`);
    logger.info('SERVER', `NODE_ENV=${process.env.NODE_ENV || 'development'} | INSTANCE=${logger.INSTANCE_ID}`);
    if (process.env.NODE_ENV !== 'production') {
        logger.warn('SERVER', 'Running in HTTP mode. Use a TLS proxy in production.');
    }
});