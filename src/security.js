import {
  randomBytes,
  scrypt as derive,
  timingSafeEqual,
  createHash,
  createCipheriv,
  createDecipheriv,
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(derive);
let activeDerivations = 0;
const waiting = [];
async function boundedScrypt(...args) {
  if (activeDerivations >= 2) {
    if (waiting.length >= 20)
      throw Object.assign(new Error('Authentication is busy. Try again shortly.'), { status: 503 });
    await new Promise((resolve) => waiting.push(resolve));
  } else activeDerivations++;
  try {
    return await scrypt(...args);
  } finally {
    if (waiting.length) waiting.shift()();
    else activeDerivations--;
  }
}
export const token = () => randomBytes(32).toString('base64url');
export const digest = (value) => createHash('sha256').update(value).digest('hex');
export function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256) {
    throw Object.assign(new Error('Use a password between 12 and 256 characters.'), {
      status: 400,
    });
  }
  const salt = randomBytes(16).toString('hex');
  const hash = await boundedScrypt(password, salt, 64, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  return `scrypt:${salt}:${hash.toString('hex')}`;
}
export async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || password.length > 256) return false;
  // Perform the same expensive operation for unknown users to reduce enumeration.
  const [, salt, expected] = (stored || `scrypt:${'0'.repeat(32)}:${'0'.repeat(128)}`).split(':');
  const actual = await boundedScrypt(password, salt, 64, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  return equal(actual.toString('hex'), expected);
}
export function encrypt(value, key) {
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv.toString('hex'), cipher.getAuthTag().toString('hex'), ciphertext.toString('hex')].join(
    '.',
  );
}
export function decrypt(value, key) {
  const [iv, tag, body] = value.split('.');
  const cipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'hex'), Buffer.from(iv, 'hex'));
  cipher.setAuthTag(Buffer.from(tag, 'hex'));
  return Buffer.concat([cipher.update(Buffer.from(body, 'hex')), cipher.final()]).toString('utf8');
}
export const escapeHtml = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
export function validEmail(value) {
  if (
    typeof value !== 'string' ||
    value.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
  ) {
    throw Object.assign(new Error('Enter a valid email address.'), { status: 400 });
  }
  return value.trim().toLowerCase();
}
export function validUrl(value, { loopback = true } = {}) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw Object.assign(new Error('Enter an absolute URL.'), { status: 400 });
  }
  if (
    url.username ||
    url.password ||
    url.hash ||
    (url.protocol !== 'https:' &&
      !(
        loopback &&
        url.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      ))
  ) {
    throw Object.assign(
      new Error('Use HTTPS, or HTTP on a loopback address for local development.'),
      { status: 400 },
    );
  }
  return url;
}
