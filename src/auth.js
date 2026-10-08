const jwt = require('jsonwebtoken');

const COOKIE_NAME = 'suitor_session';

function jwtSecret() {
  const s = process.env.JWT_SECRET;
  if (!s || s === 'change-me-to-a-long-random-string') {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('JWT_SECRET must be set in production');
    }
    return 'dev-only-secret';
  }
  return s;
}

function signToken(userId) {
  return jwt.sign({ sub: userId }, jwtSecret(), { expiresIn: '7d' });
}

function setSessionCookie(res, userId) {
  res.cookie(COOKIE_NAME, signToken(userId), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 3600 * 1000,
    path: '/',
  });
}

function clearSessionCookie(res) {
  // Options must mirror setSessionCookie (minus maxAge) or browsers may
  // refuse to delete the cookie, leaving the user logged in.
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
  });
}

function authRequired(req, res, next) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'not_authenticated' });
  try {
    const payload = jwt.verify(token, jwtSecret());
    req.userId = payload.sub;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'invalid_session' });
  }
}

// ---------- validation / sanitization ----------

const AVATAR_COLORS = ['#ff5c8a', '#8a5cf6', '#3aa8ff', '#2fbf71', '#f2a14e', '#f2c14e'];

// Trim, collapse internal whitespace, strip control characters, cap length.
function cleanStr(value, max) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());
}

module.exports = {
  COOKIE_NAME,
  setSessionCookie,
  clearSessionCookie,
  authRequired,
  AVATAR_COLORS,
  cleanStr,
  isValidEmail,
};
