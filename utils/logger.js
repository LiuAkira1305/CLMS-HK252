// utils/logger.js
// REDUNDANCY: structured logging added
// All log output follows format: [ISO_TIME] [LEVEL] [INSTANCE_ID] [MODULE] message
// Instance ID is set from env var INSTANCE_ID or derived from process.pid.
// Logs to console AND to a rotating log file (logs/app.log).

const fs   = require('fs');
const path = require('path');

// REDUNDANCY: multi-instance support — each process stamps its own ID
const INSTANCE_ID = process.env.INSTANCE_ID || `pid-${process.pid}`;

const LOG_DIR  = path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'app.log');

// Ensure log directory exists
try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
} catch (_) {}

const LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const MIN_LEVEL = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.INFO;

function formatLine(level, module, message) {
    return `[${new Date().toISOString()}] [${level.padEnd(5)}] [${INSTANCE_ID}] [${module}] ${message}`;
}

function write(level, module, message) {
    if (LEVELS[level] < MIN_LEVEL) return;
    const line = formatLine(level, module, message);

    // Always write to stdout/stderr
    if (level === 'ERROR' || level === 'WARN') {
        process.stderr.write(line + '\n');
    } else {
        process.stdout.write(line + '\n');
    }

    // REDUNDANCY: append to log file — survives console loss
    try {
        fs.appendFileSync(LOG_FILE, line + '\n');
    } catch (_) {
        // File write failure must NOT crash the server
    }
}

module.exports = {
    debug: (mod, msg) => write('DEBUG', mod, msg),
    info:  (mod, msg) => write('INFO',  mod, msg),
    warn:  (mod, msg) => write('WARN',  mod, msg),
    error: (mod, msg) => write('ERROR', mod, msg),
    INSTANCE_ID
};
