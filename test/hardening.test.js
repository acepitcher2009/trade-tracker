// Launch-hardening checks: lock-out protection, renewing sessions, sign out everywhere, alerts,
// acceptance proof, business-time-zone expiry, cheaper sync. Throwaway tenants on the DEV database only.
import './guard.js';
import '../scripts/lib/env.js';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createVerify, generateKeyPairSync, randomBytes } from 'node:crypto';
import { handle } from '../server/routes.js';
import { getPool } from '../scripts/lib/db.js';
import { createBusiness } from '../scripts/lib/tenant.js';
import { notifyBusiness, okEndpoint, vapidJwt } from '../server/push.js';

const skip = !process.env.DATABASE_URL && 'DATABASE_URL not set';
const pool = skip ? null : getPool();
const rnd = () => randomBytes(3).toString('hex');
const H = { slug: `zz-test-h-${rnd()}`, pin: String(100000 + Math.floor(Math.random() * 899999)) };
const ADDR = { address_line: '1204 Live Oak Dr', city: 'Bryan', state: 'TX', zip: '77802' };
const tok = () => `zh${randomBytes(12).toString('hex')}`;

async function call(method, path, { body, cookie, headers = {}, ip = '10.4.4.4' } = {}) {
  const res = await handle(new Request(`http://localhost/api${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), 'x-nf-client-connection-ip': ip, ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }));
  const data = await res.json().catch(() => null);
  const cookies = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]);
  return { status: res.status, data, cookies, raw: res.headers.getSetCookie?.() ?? [] };
}
const named = (r, n) => r.cookies.find((c) => c.startsWith(`${n}=`));
const login = (opts = {}) => call('POST', '/login', { body: { slug: H.slug, pin: H.pin }, ...opts });

before(async () => {
  if (skip) return;
  H.biz = await createBusiness(pool, { name: `Test ${H.slug}`, slug: H.slug, preset: 'fence', pin: H.pin });
  const l = await login({ ip: '10.4.0.1' });
  H.cookie = named(l, 'tt_session'); H.device = named(l, 'tt_device');
});
after(async () => {
  if (skip) return;
  await pool.query("delete from businesses where slug like 'zz-test-%'");
  await pool.query("delete from login_attempts where key like '%zz-test-%'");
  await pool.end();
});

test('sign-in remembers the phone with its own long-lived cookie', { skip }, async () => {
  assert.ok(H.cookie && H.device, 'session and device cookies are both issued');
  const l = await login({ ip: '10.4.0.2', headers: { cookie: H.device } });
  assert.equal(l.status, 200);
  assert.equal(named(l, 'tt_device'), undefined, 'a known phone is not given a second device id');
});

test('lock-out protection: strangers guessing PINs cannot lock the owner out of a phone they already use', { skip }, async () => {
  for (let i = 0; i < 20; i++) {
    const bad = await call('POST', '/login', { body: { slug: H.slug, pin: '000000' }, ip: `10.5.${i}.1` });
    assert.equal(bad.status, 401);
  }
  const stranger = await login({ ip: '10.5.99.1' });
  assert.equal(stranger.status, 429, 'an unknown phone is held back while the business is being attacked');
  const owner = await login({ ip: '10.5.99.2', headers: { cookie: H.device } });
  assert.equal(owner.status, 200, 'the owner’s remembered phone still gets in');
  // but a remembered phone is still limited by its own address
  for (let i = 0; i < 5; i++) assert.equal((await call('POST', '/login', { body: { slug: H.slug, pin: '111111' }, ip: '10.5.77.7', headers: { cookie: H.device } })).status, 401);
  assert.equal((await login({ ip: '10.5.77.7', headers: { cookie: H.device } })).status, 429);
  await pool.query("delete from login_attempts where key like '%zz-test-h-%'");
});

test('sessions renew themselves while in use (and hand back a fresh cookie)', { skip }, async () => {
  const l = await login({ ip: '10.6.0.1' });
  const cookie = named(l, 'tt_session');
  assert.equal((await call('GET', '/me', { cookie })).raw.length, 0, 'a fresh session is left alone');
  const mine = createHash('sha256').update(cookie.split('=')[1]).digest('hex');
  await pool.query("update sessions set expires_at = now() + interval '10 days' where token_hash = $1", [mine]);
  const r = await call('GET', '/me', { cookie });
  assert.equal(r.status, 200);
  assert.ok(r.raw.some((c) => c.startsWith('tt_session=') && /Max-Age=2592000/.test(c)), 'cookie re-issued for another 30 days');
  const [{ days }] = (await pool.query("select extract(day from expires_at - now())::int as days from sessions where token_hash = $1", [mine])).rows;
  assert.ok(days >= 29, `session pushed out to ~30 days (got ${days})`);
  await pool.query('delete from sessions where business_id = $1', [H.biz.id]);
  H.cookie = named(await login({ ip: '10.6.0.2', headers: { cookie: H.device } }), 'tt_session');
});

test('sign out everywhere ends every session and forgets remembered phones', { skip }, async () => {
  const other = await login({ ip: '10.7.0.1' }); // a second phone
  const otherCookie = named(other, 'tt_session'), otherDevice = named(other, 'tt_device');
  assert.equal((await call('GET', '/me', { cookie: otherCookie })).status, 200);
  const out = await call('POST', '/logout-all', { cookie: H.cookie, body: {} });
  assert.equal(out.status, 200);
  assert.equal((await call('GET', '/me', { cookie: H.cookie })).status, 401);
  assert.equal((await call('GET', '/me', { cookie: otherCookie })).status, 401);
  const [{ n }] = (await pool.query('select count(*)::int as n from trusted_devices where business_id = $1', [H.biz.id])).rows;
  assert.equal(n, 0);
  const l = await login({ ip: '10.7.0.2', headers: { cookie: otherDevice } });
  assert.equal(l.status, 200, 'the PIN still works');
  assert.ok(named(l, 'tt_device'), 'and the phone is remembered afresh');
  H.cookie = named(l, 'tt_session'); H.device = named(l, 'tt_device');
});

// ---------------------------------------------------------------- alerts

test('alerts: the signed push token is valid, endpoints are restricted to real push services', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pub = publicKey.export({ format: 'jwk' }), prv = privateKey.export({ format: 'jwk' });
  process.env.VAPID_PUBLIC_KEY = Buffer.concat([Buffer.from([4]), Buffer.from(pub.x, 'base64url'), Buffer.from(pub.y, 'base64url')]).toString('base64url');
  process.env.VAPID_PRIVATE_KEY = prv.d;
  const jwt = vapidJwt('https://fcm.googleapis.com', Date.UTC(2026, 8, 29));
  const [h, b, sig] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { typ: 'JWT', alg: 'ES256' });
  const claims = JSON.parse(Buffer.from(b, 'base64url'));
  assert.equal(claims.aud, 'https://fcm.googleapis.com');
  assert.equal(claims.exp, Math.floor(Date.UTC(2026, 8, 29) / 1000) + 12 * 3600);
  assert.ok(createVerify('SHA256').update(`${h}.${b}`).verify({ key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')), 'signature checks out');
  for (const ok of ['https://fcm.googleapis.com/fcm/send/abc', 'https://web.push.apple.com/xyz', 'https://updates.push.services.mozilla.com/wpush/v2/q', 'https://wns2-par02p.notify.windows.com/w/?token=1']) assert.equal(okEndpoint(ok), true, ok);
  for (const bad of ['http://fcm.googleapis.com/x', 'https://evil.example/x', 'https://169.254.169.254/latest', 'https://fcm.googleapis.com.evil.example/x', 'not a url', '']) assert.equal(okEndpoint(bad), false, bad);
});

test('alerts: subscribe / list / notify / clean up dead devices', { skip }, async () => {
  assert.equal((await call('GET', '/push/key', { cookie: H.cookie })).data.key, process.env.VAPID_PUBLIC_KEY);
  const ep1 = 'https://fcm.googleapis.com/fcm/send/aaa', ep2 = 'https://web.push.apple.com/bbb';
  assert.equal((await call('POST', '/push/subscribe', { cookie: H.cookie, body: { endpoint: 'https://evil.example/x' } })).status, 400);
  assert.equal((await call('POST', '/push/subscribe', { cookie: H.cookie, body: { endpoint: ep1 } })).status, 200);
  assert.equal((await call('POST', '/push/subscribe', { cookie: H.cookie, body: { endpoint: ep2 } })).status, 200);
  assert.equal((await call('POST', '/push/subscribe', { body: { endpoint: ep1 } })).status, 401);

  const seen = [];
  const send = async (url, init) => { seen.push({ url, init }); return { ok: url === ep1, status: url === ep1 ? 201 : 410 }; }; // ep2's phone is gone
  const sent = await notifyBusiness(H.biz.id, send);
  assert.equal(sent, 1);
  assert.equal(seen.length, 2);
  for (const s of seen) {
    assert.match(s.init.headers.Authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/);
    assert.equal(s.init.headers['Content-Length'], '0', 'the push carries no text');
  }
  const left = (await pool.query('select endpoint from push_subscriptions where business_id = $1', [H.biz.id])).rows.map((r) => r.endpoint);
  assert.deepEqual(left, [ep1], 'the dead device was removed');
  await call('POST', '/push/unsubscribe', { cookie: H.cookie, body: { endpoint: ep1 } });
  assert.equal((await pool.query('select count(*)::int as n from push_subscriptions where business_id = $1', [H.biz.id])).rows[0].n, 0);
});

test('alerts: without keys nothing is sent and the app is told alerts are unavailable', { skip }, async () => {
  const keep = { pub: process.env.VAPID_PUBLIC_KEY, prv: process.env.VAPID_PRIVATE_KEY };
  delete process.env.VAPID_PUBLIC_KEY; delete process.env.VAPID_PRIVATE_KEY;
  assert.equal((await call('GET', '/push/key', { cookie: H.cookie })).status, 404);
  assert.equal(await notifyBusiness(H.biz.id, async () => { throw new Error('should not send'); }), 0);
  process.env.VAPID_PUBLIC_KEY = keep.pub; process.env.VAPID_PRIVATE_KEY = keep.prv;
});

// ---------------------------------------------------------------- quotes: acceptance proof + expiry + alert text

async function sentQuote(extra = {}) {
  const jt = (await pool.query('select id from job_types where business_id = $1 limit 1', [H.biz.id])).rows[0].id;
  const made = await call('POST', '/clients', { cookie: H.cookie, body: { ...ADDR, name: `Hardening ${rnd()}`, phone: `979555${String(Math.floor(1000 + Math.random() * 8999))}`, job: { job_type_id: jt } } });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  const job = made.data.client.jobs[0];
  const token = tok();
  const q = await call('PUT', `/jobs/${job.id}/quote`, { cookie: H.cookie, body: { quote: { token, items: [{ name: 'Gate', unit: 'each', qty: 1, unit_price_cents: 30000 }], tax_bps: 0, deposit_pct: 50, sent_at: new Date().toISOString(), ...extra } } });
  assert.equal(q.status, 200, JSON.stringify(q.data));
  return { token, job };
}

test('acceptance: needs the "I agree" box, keeps proof, and the owner can read who said yes', { skip }, async () => {
  const { token, job } = await sentQuote();
  const noBox = await call('POST', `/q/${token}/accept`, { body: { name: 'Pat Customer' } });
  assert.equal(noBox.status, 400);
  assert.equal(noBox.data.field, 'agree');
  const ok = await call('POST', `/q/${token}/accept`, { body: { name: 'Pat Customer', agree: true }, ip: '203.0.113.9', headers: { 'user-agent': 'TestPhone/1.0' } });
  assert.equal(ok.status, 200);
  const [{ meta }] = (await pool.query('select quote_accept_meta as meta from jobs where id = $1', [job.id])).rows;
  assert.equal(meta.agreed, true);
  assert.equal(meta.name, 'Pat Customer');
  assert.equal(meta.ip, '203.0.113.9');
  assert.equal(meta.user_agent, 'TestPhone/1.0');
  assert.equal(meta.total_cents, 30000);
  const latest = await call('GET', '/push/latest', { cookie: H.cookie });
  assert.equal(latest.data.total_cents, 30000);
  assert.ok(latest.data.name);
  // changing the quote clears the acceptance AND its proof
  const q2 = await call('PUT', `/jobs/${job.id}/quote`, { cookie: H.cookie, body: { quote: { token, items: [{ name: 'Gate', unit: 'each', qty: 2, unit_price_cents: 30000 }], tax_bps: 0, deposit_pct: 50, sent_at: new Date().toISOString() } } });
  assert.equal(q2.status, 200);
  assert.equal((await pool.query('select quote_accept_meta as m from jobs where id = $1', [job.id])).rows[0].m, null);
});

test('expiry follows the business’s own time zone, not the server’s', { skip }, async () => {
  const today = async (tz) => (await pool.query("select (now() at time zone $1)::date::text as d", [tz])).rows[0].d;
  const minus = async (d, n) => (await pool.query("select ($1::date - $2::int)::text as d", [d, n])).rows[0].d;
  await pool.query("update businesses set timezone = 'Pacific/Kiritimati' where id = $1", [H.biz.id]); // UTC+14: always "tomorrow" vs UTC
  const day = await today('Pacific/Kiritimati');
  const live = await sentQuote({ valid_until: day });
  assert.equal((await call('GET', `/q/${live.token}`)).data.expired, false, 'good through the last day, in the business’s day');
  const dead = await sentQuote({ valid_until: await minus(day, 1) });
  assert.equal((await call('GET', `/q/${dead.token}`)).data.expired, true);
  assert.equal((await call('POST', `/q/${dead.token}/accept`, { body: { name: 'Too Late', agree: true } })).status, 410);
  await pool.query("update businesses set timezone = 'America/Chicago' where id = $1", [H.biz.id]);
});

// ---------------------------------------------------------------- sync

test('sync: settings only when asked for, "full" flag on a first download, old cursors start over, old deletion records are pruned', { skip }, async () => {
  const first = await call('GET', '/sync', { cookie: H.cookie });
  assert.equal(first.data.full, true);
  assert.ok(first.data.config);
  const since = new Date(Date.now() - 60_000).toISOString();
  const delta = await call('GET', `/sync?since=${encodeURIComponent(since)}&config=0`, { cookie: H.cookie });
  assert.equal(delta.data.full, false);
  assert.equal('config' in delta.data, false, 'no settings on a quiet check');
  const withCfg = await call('GET', `/sync?since=${encodeURIComponent(since)}`, { cookie: H.cookie });
  assert.ok(withCfg.data.config);
  const ancient = new Date(Date.now() - 90 * 86400_000).toISOString();
  const restart = await call('GET', `/sync?since=${encodeURIComponent(ancient)}&config=0`, { cookie: H.cookie });
  assert.equal(restart.data.full, true, 'a phone away for 90 days downloads everything again');
  assert.ok(restart.data.config);
  // pruning: an old deletion record is removed the next time a client is deleted
  const jt = (await pool.query('select id from job_types where business_id = $1 limit 1', [H.biz.id])).rows[0].id;
  const c = await call('POST', '/clients', { cookie: H.cookie, body: { ...ADDR, name: 'Prune A', phone: '9795553001', job: { job_type_id: jt } } });
  await pool.query("insert into client_tombstones (business_id, client_id, deleted_at) values ($1, gen_random_uuid(), now() - interval '120 days')", [H.biz.id]);
  await call('DELETE', `/clients/${c.data.client.id}`, { cookie: H.cookie });
  const left = (await pool.query("select count(*)::int as n from client_tombstones where business_id = $1 and deleted_at < now() - interval '90 days'", [H.biz.id])).rows[0].n;
  assert.equal(left, 0);
});

test('public pages are marked "do not index"', async () => {
  const { readFileSync } = await import('node:fs');
  assert.match(readFileSync(new URL('../index.html', import.meta.url), 'utf8'), /name="robots" content="noindex/);
  assert.match(readFileSync(new URL('../netlify.toml', import.meta.url), 'utf8'), /X-Robots-Tag = "noindex/);
});
