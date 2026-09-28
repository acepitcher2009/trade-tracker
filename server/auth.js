import { randomBytes, createHash } from 'node:crypto';
import { query } from './db.js';
import { HttpError, json, readJson } from './http.js';
import { hashPin, verifyPin } from '../shared/pin.js';

const COOKIE = 'tt_session';
const SESSION_DAYS = 30;
const WINDOW = '15 minutes';
const MAX_FAILS_PER_IP_SLUG = 5;   // one person hammering one business
const MAX_FAILS_PER_SLUG = 20;     // distributed guessing against one business

// Burn the same scrypt time for unknown slugs so timing doesn't reveal which slugs exist.
const DUMMY_HASH = hashPin('000000');

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

function readCookie(req, name) {
  const raw = req.headers.get('cookie') || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function sessionCookie(req, value, maxAgeSeconds) {
  const local = /^(localhost|127\.0\.0\.1)(:|$)/.test(new URL(req.url).host);
  return [`${COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSeconds}`,
    local ? '' : 'Secure'].filter(Boolean).join('; ');
}

/** Returns { businessId } for a valid session, or throws 401. The ONLY source of tenant identity. */
export async function requireSession(req) {
  const token = readCookie(req, COOKIE);
  if (!token) throw new HttpError(401, 'Not signed in');
  const rows = await query(
    'select business_id from sessions where token_hash = $1 and expires_at > now()', [sha256(token)]);
  if (!rows.length) throw new HttpError(401, 'Session expired');
  return { businessId: rows[0].business_id };
}

export async function login(req, ip) {
  const body = await readJson(req);
  const slug = typeof body.slug === 'string' ? body.slug.trim().toLowerCase() : '';
  const pin = typeof body.pin === 'string' ? body.pin : '';
  const keyIp = `ip:${ip}|${slug}`.slice(0, 200);
  const keySlug = `slug:${slug}`.slice(0, 200);

  const [f] = await query(
    `select count(*) filter (where key = $1)::int as ip_fails, count(*) filter (where key = $2)::int as slug_fails
       from login_attempts
      where key in ($1, $2) and not succeeded and attempted_at > now() - interval '${WINDOW}'`,
    [keyIp, keySlug]);
  if (f.ip_fails >= MAX_FAILS_PER_IP_SLUG || f.slug_fails >= MAX_FAILS_PER_SLUG) {
    throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.', { retry_after: 900 });
  }

  const biz = /^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)
    ? (await query('select id, pin_hash from businesses where slug = $1', [slug]))[0]
    : undefined;
  const ok = verifyPin(pin, biz ? biz.pin_hash : DUMMY_HASH) && !!biz && /^\d{6,8}$/.test(pin);

  if (!ok) {
    await query('insert into login_attempts (key) values ($1), ($2)', [keyIp, keySlug]);
    throw new HttpError(401, 'Wrong business or PIN');
  }

  const token = randomBytes(32).toString('base64url');
  await query(
    `insert into sessions (token_hash, business_id, expires_at)
     values ($1, $2, now() + make_interval(days => $3))`, [sha256(token), biz.id, SESSION_DAYS]);
  // Success clears this caller's failure count; opportunistic cleanup keeps tables small.
  await query('delete from login_attempts where key = $1 or attempted_at < now() - interval \'1 day\'', [keyIp]);
  await query('delete from sessions where expires_at < now()');

  return json({ ok: true }, 200, { 'set-cookie': sessionCookie(req, token, SESSION_DAYS * 86400) });
}

export async function logout(req) {
  const token = readCookie(req, COOKIE);
  if (token) await query('delete from sessions where token_hash = $1', [sha256(token)]);
  return json({ ok: true }, 200, { 'set-cookie': sessionCookie(req, '', 0) });
}
