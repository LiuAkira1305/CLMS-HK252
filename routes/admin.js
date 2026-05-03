// routes/admin.js
const express  = require('express');
const bcrypt   = require('bcrypt');
const router   = express.Router();
const User     = require('../models/User');
const { requireRole } = require('../middleware/auth');

const SALT_ROUNDS = 12;

// All admin routes require admin role
router.use(requireRole('admin'));

// POST /admin/delete-user
router.post('/delete-user', async (req, res) => {
    try {
        const { targetUsername } = req.body;
        if (!targetUsername) return res.redirect('/');
        await User.deleteOne({ username: targetUsername, role: { $ne: 'admin' } });
        res.redirect('/');
    } catch (err) {
        console.error('[Admin] Delete user error:', err);
        res.status(500).send('Server error.');
    }
});

// POST /admin/create-parent — Admin creates a parent account directly
router.post('/create-parent', async (req, res) => {
    try {
        const { username, name, email, phone, password } = req.body;
        if (!username || !name || !password) return res.redirect('/');

        const existing = await User.findOne({ username: username.trim() });
        if (existing) return res.send('<script>alert("Username already taken."); history.back();</script>');

        const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
        await User.create({ username: username.trim(), name, email, phone, passwordHash, role: 'parent', linkedDevices: [] });
        res.redirect('/');
    } catch (err) {
        console.error('[Admin] Create parent error:', err);
        res.status(500).send('Server error.');
    }
});

module.exports = router;
