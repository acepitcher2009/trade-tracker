import { randomBytes, createHash } from 'node:crypto';
import { query } from './db.js';
import { HttpError, json, readJson } from './http.js';
import { hashPin, verifyPin } from '../shared/pin.js';

const COOKIE = 'tt_session';
const DEVICE = 'tt_device';
const DEVICE_DAYS = 365;
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

function sessionCookie(req, value, maxAgeSeconds, name = COOKIE) {
  // Plain-http dev hosts (localhost or a private Wi-Fi address like 192.168.x.x on a phone) can't keep a Secure cookie.
  const local = /^(localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:|$)/.test(new URL(req.url).host);
  return [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSeconds}`,
    local ? '' : 'Secure'].filter(Boolean).join('; ');
}

/**
 * Returns { businessId } for a valid session, or throws 401. The ONLY source of tenant identity.
 * A session that is in use keeps itself alive: once a day it is pushed out another SESSION_DAYS, and `renewCookie`
 * tells the caller to re-issue the cookie so the browser's copy lives just as long.
 */
export async function requireSession(req) {
  const token = readCookie(req, COOKIE);
  if (!token) throw new HttpError(401, 'Not signed in');
  const rows = await query(
    `select business_id, expires_at > now() + make_interval(days => $2 - 1) as fresh
       from sessions where token_hash = $1 and expires_at > now()`, [sha256(token), SESSION_DAYS]);
  if (!rows.length) throw new HttpError(401, 'Session expired');
  let renewCookie = null;
  if (!rows[0].fresh) {
    await query('update sessions set expires_at = now() + make_interval(days => $2) where token_hash = $1', [sha256(token), SESSION_DAYS]);
    renewCookie = sessionCookie(req, token, SESSION_DAYS * 86400);
  }
  return { businessId: rows[0].business_id, renewCookie };
}

/** Sign this business out everywhere (every phone), including remembered devices. Needs a session. */
export async function logoutAll(req, { businessId }) {
  await query('delete from sessions where business_id = $1', [businessId]);
  await query('delete from trusted_devices where business_id = $1', [businessId]);
  return json({ ok: true }, 200, { 'set-cookie': [sessionCookie(req, '', 0), sessionCookie(req, '', 0, DEVICE)] });
}

export async function login(req, ip) {
  const body = await readJson(req);
  const slug = typeof body.slug === 'string' ? body.slug.trim().toLowerCase() : '';
  const pin = typeof body.pin === 'string' ? body.pin : '';
  const keyIp = `ip:${ip}|${slug}`.slice(0, 200);
  const keySlug = `slug:${slug}`.slice(0, 200);

  const biz = /^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)
    ? (await query('select id, pin_hash from businesses where slug = $1', [slug]))[0]
    : undefined;

  // A phone that has signed in to this business before is "trusted": someone else guessing PINs for the business
  // cannot lock it out (the per-address limit still applies to it). Unknown phones share the business-wide limit.
  const deviceToken = readCookie(req, DEVICE);
  const trusted = !!(biz && deviceToken && (await query(
    'select 1 from trusted_devices where token_hash = $1 and business_id = $2', [sha256(deviceToken), biz.id])).length);

  const [f] = await query(
    `select count(*) filter (where key = $1)::int as ip_fails, count(*) filter (where key = $2)::int as slug_fails
       from login_attempts
      where key in ($1, $2) and not succeeded and attempted_at > now() - interval '${WINDOW}'`,
    [keyIp, keySlug]);
  if (f.ip_fails >= MAX_FAILS_PER_IP_SLUG || (!trusted && f.slug_fails >= MAX_FAILS_PER_SLUG)) {
    throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.', { retry_after: 900 });
  }

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

  // Remember this phone (a long-lived random id; only its hash is stored).
  const cookies = [sessionCookie(req, token, SESSION_DAYS * 86400)];
  if (trusted) {
    await query('update trusted_devices set last_seen = now() where token_hash = $1', [sha256(deviceToken)]);
  } else {
    const dev = randomBytes(32).toString('base64url');
    await query('insert into trusted_devices (token_hash, business_id) values ($1, $2)', [sha256(dev), biz.id]);
    cookies.push(sessionCookie(req, dev, DEVICE_DAYS * 86400, DEVICE));
  }
  await query("delete from trusted_devices where last_seen < now() - interval '400 days'");

  return json({ ok: true }, 200, { 'set-cookie': cookies });
}

export async function logout(req) {
  const token = readCookie(req, COOKIE);
  if (token) await query('delete from sessions where token_hash = $1', [sha256(token)]);
  return json({ ok: true }, 200, { 'set-cookie': sessionCookie(req, '', 0) });
}
