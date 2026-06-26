import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { signToken, verifyToken } from '../utils/token.js';
import { createUser, findUserByEmail, getUser } from '../db/repo.js';

const COOKIE = 'af_session';
const cookieOpts = { httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 3600 * 1000 };

const emailOk = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e || '');

// Gate everything behind a logged-in user. Auth endpoints, the login/register
// pages, and static assets pass through.
export async function requireUser(req, res, next) {
  const open =
    req.path.startsWith('/api/auth/') ||
    req.path === '/login' ||
    req.path === '/register' ||
    /\.(css|js|png|jpg|svg|ico|woff2?)$/i.test(req.path);
  if (open) return next();

  const payload = verifyToken(req.cookies?.[COOKIE]);
  if (!payload?.uid) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'unauthorized' });
    return res.redirect('/login');
  }
  req.userId = payload.uid;
  next();
}

export async function handleRegister(req, res) {
  try {
    const { email, password, name } = req.body || {};
    if (!emailOk(email)) return res.status(400).json({ ok: false, error: 'Valid email required.' });
    if (!password || password.length < 6) return res.status(400).json({ ok: false, error: 'Password must be at least 6 characters.' });
    if (await findUserByEmail(email)) return res.status(409).json({ ok: false, error: 'An account with this email already exists.' });

    const id = uuidv4();
    const passwordHash = await bcrypt.hash(password, 10);
    await createUser({ id, email: String(email).toLowerCase().trim(), name, passwordHash });
    res.cookie(COOKIE, signToken({ uid: id }), cookieOpts);
    res.json({ ok: true, user: { id, email, name: name || '' } });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}

export async function handleLogin(req, res) {
  try {
    const { email, password } = req.body || {};
    const user = await findUserByEmail(email);
    if (!user || !(await bcrypt.compare(password || '', user.passwordHash))) {
      return res.status(401).json({ ok: false, error: 'Invalid email or password.' });
    }
    res.cookie(COOKIE, signToken({ uid: user._id }), cookieOpts);
    res.json({ ok: true, user: { id: user._id, email: user.email, name: user.name } });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}

export function handleLogout(req, res) {
  res.clearCookie(COOKIE);
  res.json({ ok: true });
}

// Current user (used by the SPA to check the session on load).
export async function handleMe(req, res) {
  const payload = verifyToken(req.cookies?.[COOKIE]);
  if (!payload?.uid) return res.status(401).json({ ok: false });
  const user = await getUser(payload.uid);
  if (!user) return res.status(401).json({ ok: false });
  res.json({ ok: true, user: { id: user._id, email: user.email, name: user.name } });
}
