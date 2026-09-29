// Offline-first sync tests: the REAL client data layer (IndexedDB via fake-indexeddb) talking to the
// REAL server handler and Neon DEV database, with a controllable "network". Throwaway tenants only.
import './guard.js';
import '../scripts/lib/env.js';
import 'fake-indexeddb/auto';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { handle } from '../server/routes.js';
import { getPool } from '../scripts/lib/db.js';
import { createBusiness } from '../scripts/lib/tenant.js';
import { makeApi } from '../src/api.js';
import { createData } from '../src/data.js';

// Local phone search (the app's own search box), shaped like the old lookup result the tests were written against.
const lk = async (data, q) => ({ matches: await data.search(q) });
const ADDR = { addressLine: '1204 Live Oak Dr', city: 'Bryan', state: 'TX', zip: '77802' };
const skip = !process.env.DATABASE_URL && 'DATABASE_URL not set';
const pool = skip ? null : getPool();
const rnd = () => randomBytes(3).toString('hex');
const T = { A: { slug: `zz-test-sa-${rnd()}`, pin: String(100000 + Math.floor(Math.random() * 899999)) },
            B: { slug: `zz-test-sb-${rnd()}`, pin: String(100000 + Math.floor(Math.random() * 899999)) } };

async function login(t) {
  const r = await handle(new Request('http://localhost/api/login', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-nf-client-connection-ip': `10.7.${Math.floor(Math.random() * 250)}.1` },
    body: JSON.stringify({ slug: t.slug, pin: t.pin }) }));
  assert.equal(r.status, 200);
  return r.headers.get('set-cookie').split(';')[0];
}

// A controllable network between one "phone" and the server.
function network(cookie) {
  const net = { down: false, loseNextWrite: false, onSyncGet: null, calls: [], paths: [] };
  net.api = makeApi(() => async (method, path, body) => {
    if (net.down) throw new Error('offline');
    net.calls.push(`${method} ${path.split('?')[0]}`); net.paths.push(path);
    if (method === 'GET' && path.startsWith('/sync') && net.onSyncGet) { const f = net.onSyncGet; net.onSyncGet = null; await f(); }
    const res = await handle(new Request(`http://localhost/api${path}`, { method,
      headers: { cookie, 'content-type': 'application/json', 'x-nf-client-connection-ip': '10.0.0.9' },
      body: body !== undefined ? JSON.stringify(body) : undefined }));
    const data = await res.json();
    if (method !== 'GET' && net.loseNextWrite) { net.loseNextWrite = false; throw new Error('response lost'); } // server DID apply it
    return { status: res.status, data };
  });
  return net;
}

let A, B;
async function device(tenant, name) {
  const net = network(tenant.cookie);
  const data = createData(tenant.slug, { api: net.api, dbName: `t-${tenant.slug}-${name}`, autoSync: false });
  await data.init(await net.api.me());
  return { data, net };
}
const serverRows = async (t, phone) => (await pool.query(
  `select c.id, c.name, (select count(*)::int from jobs j where j.business_id = c.business_id and j.client_id = c.id) as jobs
     from clients c join businesses b on b.id = c.business_id where b.slug = $1 and c.phone_digits = $2`, [t.slug, phone])).rows;
const sv = (id) => pool.query('select s.key from jobs j join statuses s on s.id = j.status_id where j.id = $1', [id]).then((r) => r.rows[0]?.key);

before(async () => {
  if (skip) return;
  for (const t of Object.values(T)) t.biz = await createBusiness(pool, { name: `Test ${t.slug}`, slug: t.slug, preset: 'fence', pin: t.pin });
  A = T.A; B = T.B;
  A.cookie = await login(A); B.cookie = await login(B);
  A.ids = (await pool.query('select (select id from job_types where business_id=$1 and name=$2) as fence, (select id from job_types where business_id=$1 and name=$3) as repair', [A.biz.id, 'Fence Installation', 'Repair'])).rows[0];
  A.status = Object.fromEntries((await pool.query('select key, id from statuses where business_id=$1', [A.biz.id])).rows.map((r) => [r.key, r.id]));
});
after(async () => {
  if (skip) return;
  await pool.query("delete from businesses where slug like 'zz-test-%'");
  await pool.query("delete from login_attempts where key like '%zz-test-%'");
  await pool.end();
});

test('initial download makes lookups work locally; three formats -> same client; unknown -> none', { skip }, async () => {
  const { data, net } = await device(A, 'init');
  assert.equal(data.getSnapshot().ready, false);
  // seed the server through another phone
  const seeder = await device(A, 'seed');
  await seeder.data.sync();
  await seeder.data.createClient({ ...ADDR, name: 'Server Sam', phone: '979-555-0001', jobTypeId: A.ids.fence });
  await seeder.data.sync();
  await data.sync();
  assert.equal(data.getSnapshot().ready, true);
  net.down = true; // from here on, no network at all
  const ids = new Set();
  for (const q of ['(979) 555-0001', '979-555-0001', '+1 979 555 0001']) {
    const r = await lk(data, q);
    assert.equal(r.matches.length, 1, q); ids.add(r.matches[0].id);
    assert.equal(r.matches[0].job_count, 1); assert.equal(r.matches[0].last_job_type, 'Fence Installation');
    assert.equal(r.matches[0].last_job_status, 'New');
  }
  assert.equal(ids.size, 1);
  assert.equal((await lk(data, '9795559999')).matches.length, 0);
  assert.equal((await lk(data, '0001')).matches.length, 1);
});

test('adding a client OFFLINE works instantly, then syncs once network returns (no duplicates)', { skip }, async () => {
  const { data, net } = await device(A, 'offline-add');
  await data.sync();
  net.down = true;
  const r = await data.createClient({ ...ADDR, name: 'Offline Olly', phone: '(979) 555-0002', jobTypeId: A.ids.repair });
  assert.equal(r.created, true);
  const local = await lk(data, '9795550002');
  assert.equal(local.matches.length, 1); assert.equal(local.matches[0].pending, true);
  assert.equal(data.getSnapshot().pending, 1);
  await data.sync();                                   // still offline: must not lose anything
  assert.equal(data.getSnapshot().pending, 1); assert.equal(data.getSnapshot().reachable, false);
  assert.equal((await serverRows(A, '9795550002')).length, 0);
  net.down = false;
  await data.sync();
  assert.equal(data.getSnapshot().pending, 0);
  const rows = await serverRows(A, '9795550002');
  assert.equal(rows.length, 1); assert.equal(rows[0].jobs, 1);
  const after = await lk(data, '9795550002');
  assert.equal(after.matches.length, 1); assert.equal(after.matches[0].pending, false);
  await data.sync(); await data.sync();               // extra syncs change nothing
  assert.equal((await serverRows(A, '9795550002')).length, 1);
});

test('lost response: retrying a request the server already applied creates no duplicates', { skip }, async () => {
  const { data, net } = await device(A, 'lossy');
  await data.sync();
  await data.createClient({ ...ADDR, name: 'Lossy Lou', phone: '9795550003', jobTypeId: A.ids.fence });
  net.loseNextWrite = true;
  await data.sync();                                   // server applied it, phone never heard back
  assert.equal(data.getSnapshot().pending, 1);
  assert.equal((await serverRows(A, '9795550003'))[0].jobs, 1);
  await data.sync();                                   // retry
  assert.equal(data.getSnapshot().pending, 0);
  const rows = await serverRows(A, '9795550003');
  assert.equal(rows.length, 1); assert.equal(rows[0].jobs, 1);
});

test('same number created on two phones merges into ONE client with both jobs', { skip }, async () => {
  const d2 = await device(A, 'conflict-2'); await d2.data.sync();
  const d1 = await device(A, 'conflict-1'); await d1.data.sync();
  d1.net.down = true;
  const mine = await d1.data.createClient({ ...ADDR, name: 'Dana One', phone: '9795550004', jobTypeId: A.ids.fence });
  await d2.data.createClient({ ...ADDR, name: 'Dana Two', phone: '(979) 555-0004', jobTypeId: A.ids.repair });
  await d2.data.sync();                                // the other phone got there first
  d1.net.down = false;
  await d1.data.sync();
  const rows = await serverRows(A, '9795550004');
  assert.equal(rows.length, 1); assert.equal(rows[0].jobs, 2);
  const local = await lk(d1.data, '9795550004');
  assert.equal(local.matches.length, 1);
  assert.equal(local.matches[0].id, rows[0].id); assert.equal(local.matches[0].name, 'Dana Two'); assert.equal(local.matches[0].job_count, 2);
  assert.equal((await d1.data.getCard(mine.client.id)).id, rows[0].id); // an open card for the old id still resolves
  assert.equal(d1.data.getSnapshot().pending, 0);
});

test('status changes: taps coalesce to one queued change; last write wins across phones', { skip }, async () => {
  const d1 = await device(A, 'lww-1'); await d1.data.sync();
  const d2 = await device(A, 'lww-2'); await d2.data.sync();
  const card = await d1.data.getCard((await lk(d1.data, '9795550001')).matches[0].id);
  const jobId = card.jobs[0].id;
  d1.net.down = true;
  await d1.data.setStatus(jobId, A.status.scheduled); await d1.data.setStatus(jobId, A.status.done); await d1.data.setStatus(jobId, A.status.scheduled);
  assert.equal(d1.data.getSnapshot().pending, 1);
  assert.equal((await d1.data.getCard(card.id)).jobs[0].status_label, 'Scheduled'); // instant locally
  await d2.data.sync();
  await d2.data.setStatus(jobId, A.status.paid); await d2.data.sync();
  assert.equal(await sv(jobId), 'paid');
  d1.net.down = false; await d1.data.sync();           // d1 syncs last -> its change wins
  assert.equal(await sv(jobId), 'scheduled');
  await d2.data.sync();
  assert.equal((await d2.data.getCard(card.id)).jobs[0].status_label, 'Scheduled');
});

test('scheduling offline: date is saved locally at once, survives coalescing, and reaches the server and other phones', { skip }, async () => {
  const d1 = await device(A, 'sch-1'); await d1.data.sync();
  const d2 = await device(A, 'sch-2'); await d2.data.sync();
  const card = await d1.data.getCard((await lk(d1.data, '9795550001')).matches[0].id);
  const jobId = card.jobs[0].id;
  d1.net.down = true;
  await d1.data.setStatus(jobId, A.status.scheduled, { date: '2026-12-01', time: '14:00' });
  await d1.data.setStatus(jobId, A.status.scheduled);                       // later tap without a schedule must not lose it
  assert.equal(d1.data.getSnapshot().pending, 1);
  const j = (await d1.data.getCard(card.id)).jobs[0];
  assert.equal(j.scheduled_date, '2026-12-01'); assert.equal(j.scheduled_time, '14:00');
  d1.net.down = false; await d1.data.sync();
  const { rows } = await pool.query("select scheduled_date::text d, to_char(scheduled_time,'HH24:MI') t from jobs where id = $1", [jobId]);
  assert.deepEqual(rows[0], { d: '2026-12-01', t: '14:00' });
  await d2.data.sync();
  assert.equal((await d2.data.getCard(card.id)).jobs[0].scheduled_date, '2026-12-01');
  await d1.data.setSchedule(jobId, { date: null, time: null }); await d1.data.sync();
  assert.equal((await pool.query('select scheduled_date from jobs where id = $1', [jobId])).rows[0].scheduled_date, null);
});

test('quotes offline: saved on the phone at once, pushed once, acceptance from the public page arrives on the next sync', { skip }, async () => {
  const d1 = await device(A, 'qt-1'); await d1.data.sync();
  const cid = (await lk(d1.data, '9795550001')).matches[0].id;
  const jobId = (await d1.data.getCard(cid)).jobs[0].id;
  const quote = { token: `zt${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}abcdefgh`, items: [{ name: 'Walk gate', unit: 'each', qty: 2, unit_price_cents: 28500 }], tax_bps: 825, deposit_pct: 50, valid_until: '2099-01-01', notes: null };
  d1.net.down = true;
  await d1.data.setQuote(jobId, quote);
  await d1.data.setQuote(jobId, { ...quote, deposit_pct: 25 });               // coalesces: only the latest is queued
  assert.equal(d1.data.getSnapshot().pending, 1);
  const local = (await d1.data.getCard(cid)).jobs[0];
  assert.equal(local.quote.deposit_pct, 25); assert.equal(local.quote_total_cents, 61703);   // 57000 + 8.25% tax (4702.5 rounds to 4703)
  await assert.rejects(d1.data.setQuote(jobId, { ...quote, items: [] }), /at least one/i);
  d1.net.down = false; await d1.data.sync();
  const { rows } = await pool.query("select quote->>'deposit_pct' d from jobs where id = $1", [jobId]);
  assert.equal(rows[0].d, '25');
  // the client accepts on the public page; this phone sees it after its next sync
  const { handle } = await import('../server/routes.js');
  const res = await handle(new Request(`http://localhost/api/q/${quote.token}/accept`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agree: true, name: 'Pat Client' }) }));
  assert.equal(res.status, 200);
  await d1.data.sync();
  assert.equal((await d1.data.getCard(cid)).jobs[0].quote_accepted_by, 'Pat Client');
  // editing the numbers afterwards clears it locally right away
  await d1.data.setQuote(jobId, { ...quote, deposit_pct: 0 });
  assert.equal((await d1.data.getCard(cid)).jobs[0].quote_accepted_by, null);
  await d1.data.sync();
  assert.equal((await pool.query('select quote_accepted_by from jobs where id = $1', [jobId])).rows[0].quote_accepted_by, null);
});

test('a pull never overwrites an edit made on this phone while syncing', { skip }, async () => {
  const d1 = await device(A, 'guard'); await d1.data.sync();
  const cid = (await lk(d1.data, '9795550001')).matches[0].id;
  const other = await device(A, 'guard-other'); await other.data.sync();
  await other.data.patchClient(cid, { notes: 'note from other phone' }); await other.data.sync();
  d1.net.onSyncGet = () => d1.data.patchClient(cid, { notes: 'typed on this phone mid-sync' });
  await d1.data.sync();
  assert.equal((await d1.data.getCard(cid)).notes, 'typed on this phone mid-sync');
  await d1.data.sync();                                // now it is pushed, and it wins as the latest write
  assert.equal(d1.data.getSnapshot().pending, 0);
  assert.equal((await pool.query('select notes from clients where id=$1', [cid])).rows[0].notes, 'typed on this phone mid-sync');
});

test('a change the server rejects is parked (not retried forever); the rest still syncs; discard works', { skip }, async () => {
  const d1 = await device(A, 'reject'); await d1.data.sync();
  const cid = (await lk(d1.data, '9795550001')).matches[0].id;
  const jobId = (await d1.data.getCard(cid)).jobs[0].id;
  d1.net.down = true;
  await d1.data.addJob(cid, { jobTypeId: A.ids.repair });
  await d1.data.setStatus(jobId, A.status.done);
  await pool.query('update job_types set active = false where id = $1', [A.ids.repair]); // retired on the server meanwhile
  d1.net.down = false; await d1.data.sync();
  const s = d1.data.getSnapshot();
  assert.equal(s.failed, 1); assert.equal(s.failedOps[0].label, 'Add job'); assert.equal(s.pending, 0);
  assert.equal(await sv(jobId), 'done');               // later change was not blocked
  await d1.data.discard(s.failedOps[0].seq);
  assert.equal(d1.data.getSnapshot().failed, 0);
  assert.equal((await d1.data.getCard(cid)).jobs.length, 1); // rejected job is gone locally too
  await pool.query('update job_types set active = true where id = $1', [A.ids.repair]);
});

test('paging: a big download arrives complete in several pages', { skip }, async () => {
  const seed = await device(A, 'page-seed'); await seed.data.sync();
  for (let i = 0; i < 6; i++) await seed.data.createClient({ ...ADDR, name: `Page ${i}`, phone: `979556000${i}`, jobTypeId: A.ids.fence });
  await seed.data.sync();
  process.env.SYNC_PAGE_SIZE = '3';
  try {
    const fresh = await device(A, 'page-fresh');
    await fresh.data.sync();
    assert.ok(fresh.net.calls.filter((c) => c === 'GET /sync').length > 1, 'expected multiple pages');
    for (let i = 0; i < 6; i++) assert.equal((await lk(fresh.data, `979556000${i}`)).matches.length, 1, `page ${i}`);
  } finally { delete process.env.SYNC_PAGE_SIZE; }
});

test('deleting a client works offline, reaches the server, and disappears from other phones', { skip }, async () => {
  const d1 = await device(A, 'del1'), d2 = await device(A, 'del2');
  await d1.data.createClient({ ...ADDR, name: 'Delete Me', phone: '979-555-0177', jobTypeId: A.ids.fence });
  await d1.data.sync(); await d2.data.sync();
  const cid = (await lk(d2.data, '9795550177')).matches[0].id;
  d1.net.down = true;
  await d1.data.deleteClient(cid);
  assert.equal((await lk(d1.data, '9795550177')).matches.length, 0);
  assert.equal(d1.data.getSnapshot().pending, 1);
  d1.net.down = false; await d1.data.sync();
  assert.equal(d1.data.getSnapshot().pending, 0);
  assert.equal((await serverRows(A, '9795550177')).length, 0);
  await d2.data.sync();
  assert.equal((await lk(d2.data, '9795550177')).matches.length, 0);
  d1.net.down = true;
  await d1.data.createClient({ ...ADDR, name: 'Oops', phone: '979-555-0178', jobTypeId: A.ids.fence });
  const oid = (await lk(d1.data, '9795550178')).matches[0].id;
  await d1.data.deleteClient(oid);
  assert.equal(d1.data.getSnapshot().pending, 0);
});

test('a job stays New until its quote is sent, then becomes Quoted (works offline)', { skip }, async () => {
  const d = await device(A, 'quotedflow');
  await d.data.createClient({ ...ADDR, name: 'Quote Flow', phone: '979-555-0181', jobTypeId: A.ids.fence });
  const cid = (await lk(d.data, '9795550181')).matches[0].id;
  const jobId = (await d.data.getCard(cid)).jobs[0].id;
  const item = { name: 'Walk gate', unit: 'each', qty: 1, unit_price_cents: 28500 };
  const quote = { token: 'q'.repeat(32), items: [item], tax_bps: 825, deposit_pct: 50, valid_until: null, notes: '', sent_at: null };
  d.net.down = true;
  await d.data.setQuote(jobId, quote);
  assert.equal((await d.data.getCard(cid)).jobs[0].status_key, 'new');        // saved, not sent
  await d.data.setQuote(jobId, { ...quote, sent_at: new Date().toISOString() });
  assert.equal((await d.data.getCard(cid)).jobs[0].status_key, 'quoted');     // sent
  d.net.down = false; await d.data.sync();
  assert.equal(d.data.getSnapshot().pending, 0);
  assert.equal(await sv(jobId), 'quoted');
});

test('visit -> quoted drops the visit date; an accepted quote shows up as a notice until dismissed', { skip }, async () => {
  const d = await device(A, 'flow2');
  await d.data.createClient({ ...ADDR, name: 'Notice Nick', phone: '979-555-0191', jobTypeId: A.ids.fence });
  const cid = (await lk(d.data, '9795550191')).matches[0].id;
  const jobId = (await d.data.getCard(cid)).jobs[0].id;
  const cfg = (await d.net.api.me()).statuses; const id = (k) => cfg.find((x) => x.key === k).id;
  await d.data.setStatus(jobId, id('visit'), { date: '2099-03-02', time: '09:30' });
  let j = (await d.data.getCard(cid)).jobs[0];
  assert.equal(j.status_key, 'visit'); assert.equal(j.scheduled_time, '09:30');
  assert.ok((await d.data.bookings()).some((b) => b.id === jobId && b.type.startsWith('Site visit')));
  const token = 'n'.repeat(32);
  await d.data.setQuote(jobId, { token, items: [{ name: 'Walk gate', unit: 'each', qty: 1, unit_price_cents: 28500 }], tax_bps: 825, deposit_pct: 0, valid_until: null, notes: '', sent_at: new Date().toISOString() });
  j = (await d.data.getCard(cid)).jobs[0];
  assert.equal(j.status_key, 'quoted'); assert.equal(j.scheduled_date, null);
  await d.data.sync();
  assert.deepEqual(await d.data.acceptances(), []);
  // the customer accepts on their own phone
  const res = await handle(new Request(`http://localhost/api/q/${token}/accept`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agree: true, name: 'Nick Notice' }) }));
  assert.equal(res.status, 200);
  await d.data.sync();
  const news = await d.data.acceptances();
  assert.equal(news.length, 1); assert.equal(news[0].name, 'Nick Notice'); assert.equal(news[0].client_name, 'Notice Nick');
  assert.equal((await d.data.getCard(cid)).jobs[0].status_key, 'accepted');
  await d.data.dismissAcceptances();
  assert.deepEqual(await d.data.acceptances(), []);
});

test('scheduling a quote from the new-client form saves client + booked visit together, offline too', { skip }, async () => {
  const d = await device(A, 'schedq');
  d.net.down = true;
  const r = await d.data.createClient({ ...ADDR, name: 'Visit Vera', phone: '979-555-0195', jobTypeId: A.ids.fence, schedule: { date: '2099-04-01', time: '14:30' } });
  const job = r.client.jobs[0];
  assert.equal(job.status_key, 'visit'); assert.equal(job.scheduled_date, '2099-04-01'); assert.equal(job.scheduled_time, '14:30');
  assert.ok((await d.data.bookings()).some((b) => b.id === job.id && b.name === 'Visit Vera'));
  await assert.rejects(() => d.data.createClient({ ...ADDR, name: 'Bad Time', phone: '979-555-0196', jobTypeId: A.ids.fence, schedule: { date: '2099-04-01', time: '14:10' } }));
  d.net.down = false; await d.data.sync();
  assert.equal(d.data.getSnapshot().pending, 0);
  assert.equal(await sv(job.id), 'visit');
  const row = (await pool.query("select scheduled_date::text d, to_char(scheduled_time,'HH24:MI') t from jobs where id = $1", [job.id])).rows[0];
  assert.deepEqual(row, { d: '2099-04-01', t: '14:30' });
  // same phone again: the visit is added to the existing client
  const again = await d.data.createClient({ ...ADDR, name: 'Visit Vera', phone: '9795550195', jobTypeId: A.ids.fence, schedule: { date: '2099-04-02', time: '09:00' } });
  assert.equal(again.created, false);
  assert.equal(again.client.jobs.filter((j) => j.status_key === 'visit').length, 2);
});

test('crew, multi-day and repeating jobs work offline; finishing a repeating job books the next one', { skip }, async () => {
  const d = await device(A, 'recur');
  d.net.down = true;
  const r = await d.data.createClient({ ...ADDR, name: 'Repeat Rita', phone: '979-555-0197', jobTypeId: A.ids.fence });
  const job = r.client.jobs[0];
  await d.data.patchJob(job.id, { duration_days: 2, assigned_to: 'Mike', recurrence: { every: 'month' } });
  await assert.rejects(() => d.data.patchJob(job.id, { duration_days: 0 }));
  await assert.rejects(() => d.data.patchJob(job.id, { recurrence: { every: 'hour' } }));
  const status = (k) => A.me?.statuses?.find((x) => x.key === k) ?? d.data.getConfig().statuses.find((x) => x.key === k);
  await d.data.setStatus(job.id, status('scheduled').id, { date: '2099-01-31', time: '09:00' });
  const days = (await d.data.bookings()).filter((b) => b.id === job.id).map((b) => b.date);
  assert.deepEqual(days, ['2099-01-31', '2099-02-01']);
  await d.data.setStatus(job.id, status('done').id);
  const card = await d.data.getCard(r.client.id);
  const next = card.jobs.find((j) => j.id !== job.id);
  assert.ok(next, 'the next visit exists');
  assert.equal(next.status_key, 'scheduled');
  assert.equal(next.scheduled_date, '2099-02-28', 'end of month is clamped, not skipped');
  assert.deepEqual([next.assigned_to, next.duration_days, next.recurrence], ['Mike', 2, { every: 'month' }]);
  assert.equal(card.jobs.find((j) => j.id === job.id).recurrence, null, 'the repeat moves to the new job');
  d.net.down = false; await d.data.sync();
  assert.equal(d.data.getSnapshot().pending, 0);
  const row = (await pool.query("select duration_days, assigned_to, recurrence, scheduled_date::text d from jobs where id = $1", [next.id])).rows[0];
  assert.deepEqual(row, { duration_days: 2, assigned_to: 'Mike', recurrence: { every: 'month' }, d: '2099-02-28' });
  assert.equal(await sv(job.id), 'done');
});

test('ISOLATION: business B phone never receives business A data', { skip }, async () => {
  const b = await device(B, 'iso'); await b.data.sync();
  assert.equal((await lk(b.data, '9795550001')).matches.length, 0);
  assert.equal((await lk(b.data, '0001')).matches.length, 0);
  await b.data.createClient({ ...ADDR, name: 'B Only', phone: '9795550001' }); await b.data.sync();
  assert.equal((await serverRows(B, '9795550001')).length, 1);
  assert.equal((await serverRows(A, '9795550001')).length, 1);
  assert.equal((await lk(b.data, '9795550001')).matches[0].name, 'B Only');
});

test('a full download drops clients that were removed elsewhere, but never unsent local work', { skip }, async () => {
  const d = await device(A, 'purge');
  await d.data.createClient({ ...ADDR, name: 'Ghost Gary', phone: '979-555-0301', jobTypeId: A.ids.fence });
  await d.data.sync();
  assert.equal((await lk(d.data, '9795550301')).matches.length, 1);
  await pool.query("delete from clients where phone_digits = '9795550301' and business_id = $1", [A.biz.id]); // gone on the server, no deletion record
  d.net.down = true;
  await d.data.createClient({ ...ADDR, name: 'Unsent Una', phone: '979-555-0302', jobTypeId: A.ids.fence }); // only on this phone so far
  d.net.down = false;
  await d.data.sync();
  assert.equal((await lk(d.data, '9795550301')).matches.length, 1, 'a quiet sync does not notice');
  // the app starts over after an update (or after 45 days away): this is the "sync everything" path
  await d.data.sync({ full: true });
  assert.equal((await lk(d.data, '9795550301')).matches.length, 0, 'the stale client is gone');
  assert.equal((await lk(d.data, '9795550302')).matches.length, 1, 'unsent work is kept (and by now sent)');
  assert.equal((await serverRows(A, '9795550302')).length, 1);
});

test('a rejected change also parks the changes that depend on it, with a plain reason', { skip }, async () => {
  const d = await device(A, 'parked');
  await d.data.createClient({ ...ADDR, name: 'Parked Pete', phone: '979-555-0303', jobTypeId: A.ids.fence });
  await d.data.sync();
  const cid = (await lk(d.data, '9795550303')).matches[0].id;
  d.net.down = true;
  await d.data.addJob(cid, { jobTypeId: A.ids.repair }); // a second job, made offline
  const jobId = (await d.data.getCard(cid)).jobs.find((j) => j.job_type_id === A.ids.repair).id;
  await d.data.setStatus(jobId, A.status.quoted);
  await d.data.patchClient(cid, { notes: 'unrelated edit that should still go through' });
  await pool.query('update job_types set active = false where id = $1', [A.ids.repair]); // the server will refuse jobs of this type
  d.net.down = false;
  await d.data.sync();
  const snap = d.data.getSnapshot();
  assert.equal(snap.failed, 2, 'the rejected job and the status change that depended on it');
  assert.ok(snap.failedOps.some((f) => /earlier change/i.test(f.error)), 'the follow-up says why it is waiting');
  assert.equal(snap.pending, 0, 'the unrelated edit went through');
  assert.equal((await pool.query('select notes from clients where business_id = $1 and phone_digits = $2', [A.biz.id, '9795550303'])).rows[0].notes, 'unrelated edit that should still go through');
  await pool.query('update job_types set active = true where id = $1', [A.ids.repair]);
  await d.data.retryFailed();
  assert.equal(d.data.getSnapshot().failed, 0);
  assert.equal(await sv(jobId), 'quoted');
});

test('quiet syncs skip the settings download; a new app version re-downloads everything once', { skip }, async () => {
  const d = await device(A, 'quiet');
  await d.data.sync();                 // a brand-new phone: everything, with settings
  await d.data.sync();                 // then quiet checks
  const syncs = () => d.net.paths.filter((p) => p.startsWith('/sync'));
  assert.ok(!syncs()[0].includes('since='), 'first download has no cursor');
  assert.ok(syncs()[1].includes('since=') && syncs()[1].includes('config=0'), `quiet check asks for changes only, no settings (${syncs()[1]})`);
  // an update: this phone remembers an older build of the app, so it starts over
  await d.data.close();
  const { openDB } = await import('idb');
  const raw = await openDB(`t-${A.slug}-quiet`, 1);
  await raw.put('meta', 'an-older-build', 'build');
  raw.close();
  const again = createData(A.slug, { api: d.net.api, dbName: `t-${A.slug}-quiet`, autoSync: false });
  await again.init(await d.net.api.me());
  await again.sync();
  assert.ok(!syncs().at(-1).includes('since='), 'after an update the whole list is downloaded again');
  await again.sync();
  assert.ok(syncs().at(-1).includes('since='), 'and only once');
  await again.close();
});

const ph = () => `979557${String(Math.floor(1000 + Math.random() * 8999))}`;
const Q1 = (token, sent) => ({ token, items: [{ name: 'Gate', unit: 'each', qty: 1, unit_price_cents: 30000 }], tax_bps: 0, deposit_pct: 0, ...(sent ? { sent_at: new Date().toISOString() } : {}) });

test('a job has no type until its quote is saved with one, offline or not', { skip }, async () => {
  const d = await device(A, 'jt');
  await d.data.sync();
  d.net.down = true;
  const { client } = await d.data.createClient({ name: 'No Type', phone: ph(), ...ADDR }); // no job type asked
  const job = client.jobs[0];
  assert.equal(job.job_type_id, null);
  assert.equal(job.job_type, 'Estimate');
  await assert.rejects(d.data.setQuote(job.id, Q1('zj' + rnd() + rnd() + rnd() + rnd())), /kind of job/i);
  await d.data.setQuote(job.id, Q1('zj' + rnd() + rnd() + rnd() + rnd()), A.ids.fence);
  await d.data.setQuote(job.id, Q1('zj' + rnd() + rnd() + rnd() + rnd(), true)); // saved again later without re-picking
  d.net.down = false;
  await d.data.sync();
  assert.equal(d.data.getSnapshot().failed, 0);
  const row = (await pool.query('select job_type_id from jobs where id = $1', [job.id])).rows[0];
  assert.equal(row.job_type_id, A.ids.fence, 'the type chosen offline reached the server');
});

test('deleting a quote removes it on this phone now, on the server after sync, and on other phones on their next sync', { skip }, async () => {
  const d1 = await device(A, 'del1'), d2 = await device(A, 'del2');
  const { client } = await d1.data.createClient({ name: 'Delete Me', phone: ph(), ...ADDR });
  await d1.data.sync(); await d2.data.sync();
  const jobId = client.jobs[0].id;
  assert.ok((await d2.data.getCard(client.id)).jobs.some((j) => j.id === jobId));
  await d1.data.deleteJob(jobId);
  assert.equal((await d1.data.getCard(client.id)).jobs.length, 0, 'gone from this phone immediately');
  await d1.data.sync();
  assert.equal((await pool.query('select deleted_at is not null as gone from jobs where id = $1', [jobId])).rows[0].gone, true);
  await d2.data.sync();
  assert.equal((await d2.data.getCard(client.id)).jobs.length, 0, 'the other phone drops it on its next sync');
  // a job that never left the phone just disappears, nothing is sent
  d1.net.down = true;
  const { client: c2 } = await d1.data.createClient({ name: 'Never Synced', phone: ph(), ...ADDR });
  await d1.data.deleteJob(c2.jobs[0].id);
  d1.net.down = false;
  await d1.data.sync();
  assert.equal(d1.data.getSnapshot().failed, 0);
  assert.equal((await d1.data.getCard(c2.id)).jobs.length, 0);
  // a phone that was away and does a full download also loses it
  const d3 = await device(A, 'del3');
  await d3.data.sync();
  assert.equal((await d3.data.getCard(client.id)).jobs.length, 0);
});

test('payments: a deposit keeps the job open; the last payment moves a finished job to Paid; a decline shows up as news', { skip }, async () => {
  const d = await device(A, 'pay');
  const { client } = await d.data.createClient({ name: 'Pay Me', phone: ph(), ...ADDR });
  const jobId = client.jobs[0].id;
  await d.data.setQuote(jobId, Q1('zp' + rnd() + rnd() + rnd() + rnd(), true), A.ids.fence); // $300.00
  await d.data.setStatus(jobId, A.status.done);
  const today = new Date().toISOString().slice(0, 10);
  await d.data.addPayment(jobId, { amountCents: 10000, method: 'cash', date: today });
  let job = (await d.data.getCard(client.id)).jobs[0];
  assert.equal(job.paid_cents, 10000);
  assert.equal(job.balance_cents, 20000);
  assert.equal(job.status_key, 'done', 'still owed, still to collect');
  await d.data.addPayment(jobId, { amountCents: 20000, method: 'check', date: today, note: 'check 1042' });
  job = (await d.data.getCard(client.id)).jobs[0];
  assert.equal(job.balance_cents, 0);
  assert.equal(job.status_key, 'paid');
  await assert.rejects(d.data.addPayment(jobId, { amountCents: 0, method: 'cash', date: today }), /at least/);
  await d.data.removePayment(jobId, job.payments[0].id);
  assert.equal((await d.data.getCard(client.id)).jobs[0].paid_cents, 20000);
  await d.data.sync();
  const row = (await pool.query('select jsonb_array_length(payments) as n from jobs where id = $1', [jobId])).rows[0];
  assert.equal(row.n, 1, 'payments reached the server');
  // a customer declines a different quote: the owner's phone lists it once
  const { client: c2 } = await d.data.createClient({ name: 'Says No', phone: ph(), ...ADDR });
  const token = 'zd' + rnd() + rnd() + rnd() + rnd();
  await d.data.setQuote(c2.jobs[0].id, Q1(token, true), A.ids.fence);
  await d.data.sync();
  await d.data.dismissAcceptances();
  await handle(new Request(`http://localhost/api/q/${token}/decline`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-nf-client-connection-ip': '10.0.0.8' }, body: JSON.stringify({ reason: 'Found someone cheaper' }) }));
  await d.data.sync();
  const news = await d.data.acceptances();
  assert.equal(news.length, 1);
  assert.equal(news[0].declined, true);
  assert.equal(news[0].reason, 'Found someone cheaper');
  await d.data.dismissAcceptances();
  assert.equal((await d.data.acceptances()).length, 0);
});

test('jobs saved on a phone by an older version (no payments list) still open', { skip }, async () => {
  const d = await device(A, 'old');
  const { client } = await d.data.createClient({ name: 'Old Copy', phone: ph(), ...ADDR });
  await d.data.sync();
  await d.data.close();
  const { openDB } = await import('idb');
  const raw = await openDB(`t-${A.slug}-old`, 1);
  for (const j of await raw.getAll('jobs')) { const { payments, declined_at, decline_reason, ...older } = j; await raw.put('jobs', older); }
  raw.close();
  const again = createData(A.slug, { api: d.net.api, dbName: `t-${A.slug}-old`, autoSync: false });
  await again.init(await d.net.api.me());
  const card = await again.getCard(client.id);
  assert.deepEqual(card.jobs[0].payments, []);
  assert.equal(card.jobs[0].paid_cents, 0);
  assert.ok((await again.board()).every((j) => Array.isArray(j.payments)));
  await again.close();
});

test('tour demo mode: seeds sample customers, never touches the server, never queues changes, stays out of the real database', { skip }, async () => {
  const { seedTour } = await import('../src/tour/sample.js');
  const real = await device(A, 'tour-real');
  await real.data.sync();
  const before = (await real.data.board()).length;
  const calls = [];
  const deny = new Proxy({}, { get: (_, k) => async (...a) => { calls.push(String(k)); throw new Error('demo must not call the server'); } });
  const demo = createData(A.slug, { api: deny, dbName: `t-${A.slug}-tour-demo`, autoSync: false, demo: true });
  const cfg = real.data.getConfig();
  await demo.init(cfg);
  await seedTour(demo, cfg);
  const jobs = await demo.board();
  assert.ok(jobs.length >= 5 && jobs.every((j) => j.client_name.startsWith('Sample:')));
  assert.ok(jobs.some((j) => j.status_key === 'quoted') && jobs.some((j) => j.status_key === 'accepted' || j.status_key === 'done'));
  await demo.sync();
  assert.deepEqual(calls, [], 'no API calls at all');
  assert.equal((await demo.pending?.()) ?? 0, 0);
  assert.equal((await real.data.board()).length, before, 'real board untouched');
  await demo.close(); await real.data.close();
});
