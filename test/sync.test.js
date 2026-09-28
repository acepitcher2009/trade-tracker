// Offline-first sync tests: the REAL client data layer (IndexedDB via fake-indexeddb) talking to the
// REAL server handler and Neon DEV database, with a controllable "network". Throwaway tenants only.
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
  const net = { down: false, loseNextWrite: false, onSyncGet: null, calls: [] };
  net.api = makeApi(() => async (method, path, body) => {
    if (net.down) throw new Error('offline');
    net.calls.push(`${method} ${path.split('?')[0]}`);
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
  await seeder.data.createClient({ name: 'Server Sam', phone: '979-555-0001', jobTypeId: A.ids.fence });
  await seeder.data.sync();
  await data.sync();
  assert.equal(data.getSnapshot().ready, true);
  net.down = true; // from here on, no network at all
  const ids = new Set();
  for (const q of ['(979) 555-0001', '979-555-0001', '+1 979 555 0001']) {
    const r = await data.lookup(q);
    assert.equal(r.matches.length, 1, q); ids.add(r.matches[0].id);
    assert.equal(r.matches[0].job_count, 1); assert.equal(r.matches[0].last_job_type, 'Fence Installation');
    assert.equal(r.matches[0].last_job_status, 'Quoted');
  }
  assert.equal(ids.size, 1);
  assert.equal((await data.lookup('9795559999')).matches.length, 0);
  assert.equal((await data.lookup('0001')).matches.length, 1);
});

test('adding a client OFFLINE works instantly, then syncs once network returns (no duplicates)', { skip }, async () => {
  const { data, net } = await device(A, 'offline-add');
  await data.sync();
  net.down = true;
  const r = await data.createClient({ name: 'Offline Olly', phone: '(979) 555-0002', jobTypeId: A.ids.repair });
  assert.equal(r.created, true);
  const local = await data.lookup('9795550002');
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
  const after = await data.lookup('9795550002');
  assert.equal(after.matches.length, 1); assert.equal(after.matches[0].pending, false);
  await data.sync(); await data.sync();               // extra syncs change nothing
  assert.equal((await serverRows(A, '9795550002')).length, 1);
});

test('lost response: retrying a request the server already applied creates no duplicates', { skip }, async () => {
  const { data, net } = await device(A, 'lossy');
  await data.sync();
  await data.createClient({ name: 'Lossy Lou', phone: '9795550003', jobTypeId: A.ids.fence });
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
  const mine = await d1.data.createClient({ name: 'Dana One', phone: '9795550004', jobTypeId: A.ids.fence });
  await d2.data.createClient({ name: 'Dana Two', phone: '(979) 555-0004', jobTypeId: A.ids.repair });
  await d2.data.sync();                                // the other phone got there first
  d1.net.down = false;
  await d1.data.sync();
  const rows = await serverRows(A, '9795550004');
  assert.equal(rows.length, 1); assert.equal(rows[0].jobs, 2);
  const local = await d1.data.lookup('9795550004');
  assert.equal(local.matches.length, 1);
  assert.equal(local.matches[0].id, rows[0].id); assert.equal(local.matches[0].name, 'Dana Two'); assert.equal(local.matches[0].job_count, 2);
  assert.equal((await d1.data.getCard(mine.client.id)).id, rows[0].id); // an open card for the old id still resolves
  assert.equal(d1.data.getSnapshot().pending, 0);
});

test('status changes: taps coalesce to one queued change; last write wins across phones', { skip }, async () => {
  const d1 = await device(A, 'lww-1'); await d1.data.sync();
  const d2 = await device(A, 'lww-2'); await d2.data.sync();
  const card = await d1.data.getCard((await d1.data.lookup('9795550001')).matches[0].id);
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

test('a pull never overwrites an edit made on this phone while syncing', { skip }, async () => {
  const d1 = await device(A, 'guard'); await d1.data.sync();
  const cid = (await d1.data.lookup('9795550001')).matches[0].id;
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
  const cid = (await d1.data.lookup('9795550001')).matches[0].id;
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
  for (let i = 0; i < 6; i++) await seed.data.createClient({ name: `Page ${i}`, phone: `979556000${i}`, jobTypeId: A.ids.fence });
  await seed.data.sync();
  process.env.SYNC_PAGE_SIZE = '3';
  try {
    const fresh = await device(A, 'page-fresh');
    await fresh.data.sync();
    assert.ok(fresh.net.calls.filter((c) => c === 'GET /sync').length > 1, 'expected multiple pages');
    for (let i = 0; i < 6; i++) assert.equal((await fresh.data.lookup(`979556000${i}`)).matches.length, 1, `page ${i}`);
  } finally { delete process.env.SYNC_PAGE_SIZE; }
});

test('ISOLATION: business B phone never receives business A data', { skip }, async () => {
  const b = await device(B, 'iso'); await b.data.sync();
  assert.equal((await b.data.lookup('9795550001')).matches.length, 0);
  assert.equal((await b.data.lookup('0001')).matches.length, 0);
  await b.data.createClient({ name: 'B Only', phone: '9795550001' }); await b.data.sync();
  assert.equal((await serverRows(B, '9795550001')).length, 1);
  assert.equal((await serverRows(A, '9795550001')).length, 1);
  assert.equal((await b.data.lookup('9795550001')).matches[0].name, 'B Only');
});
