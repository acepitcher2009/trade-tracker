// PIN hashing with Node's built-in scrypt (no extra dependency).
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export function validatePin(pin) {
  if (typeof pin !== 'string' || !/^\d{6,8}$/.test(pin)) {
    throw new Error('PIN must be 6 to 8 digits.');
  }
}

export function hashPin(pin) {
  validatePin(pin);
  const salt = randomBytes(16);
  const hash = scryptSync(pin, salt, 32);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPin(pin, stored) {
  try {
    const [scheme, saltB64, hashB64] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const expected = Buffer.from(hashB64, 'base64');
    const actual = scryptSync(String(pin), Buffer.from(saltB64, 'base64'), expected.length);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
