import crypto from 'crypto';

// Minimal stateless session token: base64url(payload).hmacSHA256 — signed with
// SECRET_KEY. Avoids an extra JWT dependency. Used in an httpOnly cookie.

function secret() {
  return process.env.SECRET_KEY || 'autoforge-insecure-default';
}

export function signToken(payload, ttlMs = 30 * 24 * 3600 * 1000) {
  const body = { ...payload, exp: Date.now() + ttlMs };
  const b64 = Buffer.from(JSON.stringify(body)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret()).update(b64).digest('base64url');
  return `${b64}.${sig}`;
}

export function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [b64, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', secret()).update(b64).digest('base64url');
  // constant-time compare
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}
