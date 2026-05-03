// routes/auth.js
const express   = require('express');
const bcrypt    = require('bcrypt');
const rateLimit = require('express-rate-limit');
const fs        = require('fs');
const path      = require('path');
const router    = express.Router();
const User      = require('../models/User');

const SALT_ROUNDS = 12;
const authNotice = (path, type, title, msg) =>
    `${path}?notice=${encodeURIComponent(type)}&title=${encodeURIComponent(title)}&msg=${encodeURIComponent(msg)}`;

// FIX: rate limit added — max 5 login attempts per IP per 15 minutes
const loginLimiter = rateLimit({
    windowMs:         15 * 60 * 1000,
    max:              5,
    standardHeaders:  true,
    legacyHeaders:    false,
    handler: (req, res) => res.redirect(authNotice('/login', 'error', 'Too many attempts', 'Please try again in 15 minutes.'))
});

// GET /login
router.get('/login', (req, res) => {
    if (req.session?.user) return res.redirect('/');
    const html = fs.readFileSync(path.join(__dirname, '..', 'views', 'login.html'), 'utf8')
        .replaceAll('{{CSRF_TOKEN}}', req.session?.csrfToken || '');
    res.send(html);
});

// POST /login — rate limited
router.post('/login', loginLimiter, async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password)
            return res.redirect(authNotice('/login', 'error', 'Missing fields', 'Please fill in all fields.'));

        const user = await User.findOne({ username: username.trim() });
        if (!user) 
            return res.redirect(authNotice('/login', 'error', 'Incorrect password', 'Invalid username or password.'));

        const match = await bcrypt.compare(password, user.passwordHash);
        if (!match)
            return res.redirect(authNotice('/login', 'error', 'Incorrect password', 'Invalid username or password.'));

        req.session.user = { username: user.username, role: user.role, name: user.name };
        res.redirect('/');
    } catch (err) {
        console.error('[Auth] Login error:', err);
        res.status(500).send('Server error.');
    }
});

// GET /register — Only parents can self-register
router.get('/register', (req, res) => {
    if (req.session?.user) return res.redirect('/');
    const html = fs.readFileSync(path.join(__dirname, '..', 'views', 'register.html'), 'utf8')
        .replaceAll('{{CSRF_TOKEN}}', req.session?.csrfToken || '');
    res.send(html);
});

// POST /register
router.post('/register', async (req, res) => {
    try {
        const { username, name, email, phone, password, confirmPassword } = req.body;

        if (!username || !name || !password || !confirmPassword)
            return res.redirect(authNotice('/register', 'error', 'Missing fields', 'Please fill in all required fields.'));

        if (password !== confirmPassword)
            return res.redirect(authNotice('/register', 'error', 'Password mismatch', 'Passwords do not match.'));

        if (password.length < 6)
            return res.redirect(authNotice('/register', 'error', 'Weak password', 'Password must be at least 6 characters.'));

        const existing = await User.findOne({ username: username.trim() });
        if (existing)
            return res.redirect(authNotice('/register', 'error', 'Username taken', 'Please choose another username.'));

        const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

        await User.create({
            username: username.trim(),
            name,
            role: 'parent',      // Self-registration creates parents ONLY
            email,
            phone,
            passwordHash,
            linkedDevices: []
        });

        res.redirect(authNotice('/login', 'success', 'Registration successful', 'Your account is ready. Please sign in.'));
    } catch (err) {
        console.error('[Auth] Register error:', err);
        res.status(500).send('Server error.');
    }
});

// GET /logout
router.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
