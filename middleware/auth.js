// middleware/auth.js
// Session authentication and role-based access guards.

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

module.exports = { requireLogin, requireRole };
