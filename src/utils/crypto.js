import crypto from 'crypto';

// AES-256-GCM encryption for secrets stored in MongoDB.
// Key is derived from SECRET_KEY (.env) via scrypt so any-length input works.
// Format on disk: <ivHex>:<authTagHex>:<cipherHex>

const ALGO = 'aes-256-gcm';

function getKey() {
  const secret = process.env.SECRET_KEY;
  if (!secret || secret === 'change_this_to_a_random_32_char_string') {
    // Still functional in dev, but warn loudly once.
    if (!getKey._warned) {
      console.warn('⚠️  SECRET_KEY is unset or default — set a real value in .env for secure secret storage.');
      getKey._warned = true;
    }
  }
  return crypto.scryptSync(secret || 'autoforge-insecure-default', 'autoforge-salt', 32);
}

export function encrypt(plain) {
  if (plain === undefined || plain === null || plain === '') return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

export function decrypt(stored) {
  if (!stored) return '';
  const parts = String(stored).split(':');
  if (parts.length !== 3) return ''; // not our format — treat as empty
  try {
    const [ivHex, tagHex, dataHex] = parts;
    const decipher = crypto.createDecipheriv(ALGO, getKey(), Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    const dec = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]);
    return dec.toString('utf8');
  } catch {
    return '';
  }
}
