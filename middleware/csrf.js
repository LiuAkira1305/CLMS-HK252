const crypto = require('crypto');

function ensureCsrfToken(req, res, next) {
    if (!req.session) return next();
    if (!req.session.csrfToken) {
        req.session.csrfToken = crypto.randomBytes(32).toString('hex');
    }
    res.locals.csrfToken = req.session.csrfToken;
    next();
}

function verifyCsrf(req, res, next) {
    if (req.method !== 'POST') return next();

    if (req.path.startsWith('/iot/')) return next();

    const expected = req.session?.csrfToken;
    const submitted = req.body?._csrf || req.get('x-csrf-token');

    if (!expected || !submitted) {
        return res.status(403).send('CSRF validation failed.');
    }

    const a = Buffer.from(String(expected));
    const b = Buffer.from(String(submitted));

    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return res.status(403).send('CSRF validation failed.');
    }

    next();
}

function csrfField(token) {
    return token
        ? `<input type="hidden" name="_csrf" value="${String(token).replace(/[&<>"']/g, (ch) => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        })[ch])}">`
        : '';
}

module.exports = { ensureCsrfToken, verifyCsrf, csrfField };
