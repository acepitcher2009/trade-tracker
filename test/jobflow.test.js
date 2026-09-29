// Job flow: job type picked at quote time, deleting a quote, customer decline, payments, job notes. Dev database only.
import './guard.js';
import '../scripts/lib/env.js';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { handle } from '../server/routes.js';
import { getPool } from '../scripts/lib/db.js';
import { createBusiness } from '../scripts/lib/tenant.js';


const skip = !process.env.DATABASE_URL && 'DATABASE_URL not set';
const pool = skip ? null : getPool();
const rnd = () => randomBytes(3).toString('hex');
const H = { slug: `zz-test-jf-${rnd()}`, pin: String(100000 + Math.floor(Math.random() * 899999)) };
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
  H.cookie = named(await login({ ip: '10.9.0.1' }), 'tt_session');
  H.jt = (await pool.query('select id from job_types where business_id = $1 order by sort_order limit 1', [H.biz.id])).rows[0].id;
});
after(async () => {
  if (skip) return;
  await pool.query("delete from businesses where slug like 'zz-test-%'");
  await pool.query("delete from login_attempts where key like '%zz-test-%'");
  await pool.end();
});

const phone = () => `979556${String(Math.floor(1000 + Math.random() * 8999))}`;
async function newClient() {
  const made = await call('POST', '/clients', { cookie: H.cookie, body: { ...ADDR, name: `Flow ${rnd()}`, phone: phone(), job: {} } });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  return made.data.client;
}
const Q = (token, qty = 1) => ({ token, items: [{ name: 'Gate', unit: 'each', qty, unit_price_cents: 30000 }], tax_bps: 0, deposit_pct: 50, sent_at: new Date().toISOString() });

test('a new customer starts with no job type; the quote form picks it', { skip }, async () => {
  const c = await newClient();
  assert.equal(c.jobs.length, 1, 'the job is created without a type');
  const job = c.jobs[0];
  assert.equal(job.job_type_id, null);
  const no = await call('PUT', `/jobs/${job.id}/quote`, { cookie: H.cookie, body: { quote: Q(tok()) } });
  assert.equal(no.status, 400, 'a quote cannot be saved until the kind of job is chosen');
  assert.equal(no.data.field, 'job_type_id');
  const yes = await call('PUT', `/jobs/${job.id}/quote`, { cookie: H.cookie, body: { quote: Q(tok()), job_type_id: H.jt } });
  assert.equal(yes.status, 200, JSON.stringify(yes.data));
  assert.equal(yes.data.job.job_type_id, H.jt);
  assert.ok(yes.data.job.job_type);
  const again = await call('PUT', `/jobs/${job.id}/quote`, { cookie: H.cookie, body: { quote: Q(tok(), 2) } });
  assert.equal(again.status, 200, 'once chosen it does not have to be sent again');
  const bad = await call('PUT', `/jobs/${job.id}/quote`, { cookie: H.cookie, body: { quote: Q(tok()), job_type_id: '00000000-0000-4000-8000-000000000000' } });
  assert.equal(bad.status, 400, 'another business’s (or unknown) job type is refused');
});

test('job notes and payments can be edited; bad payments are refused', { skip }, async () => {
  const job = (await newClient()).jobs[0];
  const n = await call('PATCH', `/jobs/${job.id}`, { cookie: H.cookie, body: { notes: 'Gate code 4411' } });
  assert.equal(n.data.job.notes, 'Gate code 4411');
  const pay = { id: '11111111-1111-4111-8111-111111111111', amount_cents: 15000, method: 'check', date: '2026-09-29', note: 'Deposit' };
  const ok = await call('PATCH', `/jobs/${job.id}`, { cookie: H.cookie, body: { payments: [pay] } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.deepEqual(ok.data.job.payments, [pay]);
  for (const bad of [{ ...pay, amount_cents: 0 }, { ...pay, amount_cents: 1.5 }, { ...pay, date: 'soon' }, { ...pay, id: 'x' }]) {
    assert.equal((await call('PATCH', `/jobs/${job.id}`, { cookie: H.cookie, body: { payments: [bad] } })).status, 400);
  }
  assert.equal((await call('PATCH', `/jobs/${job.id}`, { cookie: H.cookie, body: { payments: [{ ...pay, method: 'bitcoin' }] } })).data.job.payments[0].method, 'other');
});

test('deleting a quote hides it, tells other phones on their next sync, and is safe to repeat', { skip }, async () => {
  const c = await newClient();
  const job = c.jobs[0];
  const before = (await call('GET', '/sync', { cookie: H.cookie })).data;
  const d = await call('PATCH', `/jobs/${job.id}`, { cookie: H.cookie, body: { deleted: true } });
  assert.equal(d.status, 200);
  assert.equal(d.data.deleted, true);
  assert.equal((await call('PATCH', `/jobs/${job.id}`, { cookie: H.cookie, body: { deleted: true } })).status, 200, 'repeating it is fine');
  const card = await call('GET', `/clients/${c.id}`, { cookie: H.cookie });
  assert.equal(card.data.client.jobs.length, 0, 'the customer stays, the job is gone');
  const delta = (await call('GET', `/sync?since=${encodeURIComponent(before.server_time)}`, { cookie: H.cookie })).data;
  assert.ok(delta.jobs.find((j) => j.id === job.id && j.deleted_at), 'a phone that already had it is told to drop it');
  const full = (await call('GET', '/sync', { cookie: H.cookie })).data;
  assert.equal(full.jobs.find((j) => j.id === job.id), undefined, 'a fresh download never includes it');
  assert.equal(full.clients.some((x) => x.id === c.id), true);
});

test('customer decline: recorded with the reason, the owner is told, accepting later or editing the quote clears it', { skip }, async () => {
  const job = (await newClient()).jobs[0];
  const token = tok();
  assert.equal((await call('PUT', `/jobs/${job.id}/quote`, { cookie: H.cookie, body: { quote: Q(token), job_type_id: H.jt } })).status, 200);
  const d = await call('POST', `/q/${token}/decline`, { body: { reason: 'Too expensive right now' } });
  assert.equal(d.status, 200);
  assert.ok(d.data.declined_at);
  const row = (await pool.query('select declined_at, decline_reason from jobs where id = $1', [job.id])).rows[0];
  assert.equal(row.decline_reason, 'Too expensive right now');
  const latest = await call('GET', '/push/latest', { cookie: H.cookie });
  assert.equal(latest.data.kind, 'declined');
  assert.equal((await call('POST', `/q/${token}/decline`, { body: { reason: 'again' } })).status, 200, 'declining twice is harmless');
  assert.equal((await pool.query('select decline_reason from jobs where id = $1', [job.id])).rows[0].decline_reason, 'Too expensive right now', 'the first reason is kept');
  // owner edits the quote: the old "no" no longer applies
  await call('PUT', `/jobs/${job.id}/quote`, { cookie: H.cookie, body: { quote: Q(token, 2) } });
  assert.equal((await pool.query('select declined_at from jobs where id = $1', [job.id])).rows[0].declined_at, null);
  // decline, then change of heart: accepting clears the decline
  await call('POST', `/q/${token}/decline`, { body: {} });
  const acc = await call('POST', `/q/${token}/accept`, { body: { name: 'Pat Customer', agree: true } });
  assert.equal(acc.status, 200);
  assert.equal((await pool.query('select declined_at from jobs where id = $1', [job.id])).rows[0].declined_at, null);
  // once accepted it cannot be declined
  assert.equal((await call('POST', `/q/${token}/decline`, { body: {} })).status, 409);
  assert.equal((await call('POST', '/q/not-a-real-token-at-all-xx/decline', { body: {} })).status, 404);
});
