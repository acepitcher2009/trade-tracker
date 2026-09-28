// Integration tests: call the API handler directly against the Neon DEV branch using
// throwaway tenants (zz-test-*) that are deleted afterwards. Never touches real tenants.
import '../scripts/lib/env.js';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { handle } from '../server/routes.js';
import { getPool } from '../scripts/lib/db.js';
import { createBusiness } from '../scripts/lib/tenant.js';

const skip = !process.env.DATABASE_URL && 'DATABASE_URL not set';
const pool = skip ? null : getPool();
const rnd = () => randomBytes(3).toString('hex');
const pinOf = () => String(Math.floor(100000 + Math.random() * 899999));

async function call(method, path, { body, cookie, headers = {}, ip = '10.0.0.1' } = {}) {
  const res = await handle(new Request(`http://localhost/api${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}), 'x-nf-client-connection-ip': ip, ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }));
  const data = await res.json().catch(() => null);
  const sc = res.headers.get('set-cookie');
  return { status: res.status, data, cookie: sc ? sc.split(';')[0] : null, setCookie: sc };
}

const A = { slug: `zz-test-a-${rnd()}`, pin: pinOf() };
const B = { slug: `zz-test-b-${rnd()}`, pin: pinOf() };
const RL = { slug: `zz-test-rl-${rnd()}`, pin: pinOf() };
const PHONE = '9795551234';

before(async () => {
  if (skip) return;
  for (const t of [A, B, RL]) {
    t.biz = await createBusiness(pool, { name: `Test ${t.slug}`, slug: t.slug, preset: 'fence', pin: t.pin });
  }
  for (const t of [A, B]) {
    const r = await call('POST', '/login', { body: { slug: t.slug, pin: t.pin } });
    assert.equal(r.status, 200);
    t.cookie = r.cookie;
    t.me = (await call('GET', '/me', { cookie: t.cookie })).data;
  }
});

after(async () => {
  if (skip) return;
  await pool.query('delete from businesses where slug like $1', ['zz-test-%']); // cascades
  await pool.query('delete from login_attempts where key like $1 or key like $2', ['%zz-test-%', '%zz-test-%']);
  await pool.end();
});

test('auth: unauthenticated requests are rejected', { skip }, async () => {
  for (const [m, p] of [['GET', '/me'], ['GET', `/lookup?q=${PHONE}`], ['POST', '/clients'], ['GET', `/clients/${randomUUID()}`]]) {
    const r = await call(m, p, { body: m === 'POST' ? {} : undefined });
    assert.equal(r.status, 401, `${m} ${p}`);
  }
  assert.equal((await call('GET', '/me', { cookie: 'tt_session=garbage' })).status, 401);
});

test('auth: cookie is HttpOnly + SameSite=Strict; wrong PIN / unknown slug are identical 401s', { skip }, async () => {
  const ok = await call('POST', '/login', { body: { slug: A.slug, pin: A.pin } });
  assert.match(ok.setCookie, /HttpOnly/);
  assert.match(ok.setCookie, /SameSite=Strict/);
  const bad = await call('POST', '/login', { body: { slug: A.slug, pin: '000000' }, ip: '10.9.9.9' });
  const nobody = await call('POST', '/login', { body: { slug: 'zz-test-nobody', pin: '000000' }, ip: '10.9.9.9' });
  assert.equal(bad.status, 401);
  assert.deepEqual(bad.data, nobody.data);
});

test('auth: rate limiting locks out after 5 failures, even with the right PIN', { skip }, async () => {
  for (let i = 0; i < 5; i++) {
    assert.equal((await call('POST', '/login', { body: { slug: RL.slug, pin: '111111' }, ip: '10.1.1.1' })).status, 401);
  }
  const locked = await call('POST', '/login', { body: { slug: RL.slug, pin: RL.pin }, ip: '10.1.1.1' });
  assert.equal(locked.status, 429);
});

test('auth: logout invalidates the session', { skip }, async () => {
  const r = await call('POST', '/login', { body: { slug: A.slug, pin: A.pin } });
  assert.equal((await call('GET', '/me', { cookie: r.cookie })).status, 200);
  await call('POST', '/logout', { cookie: r.cookie, body: {} });
  assert.equal((await call('GET', '/me', { cookie: r.cookie })).status, 401);
});

test('csrf: non-JSON and cross-origin mutations are blocked', { skip }, async () => {
  const noJson = await handle(new Request('http://localhost/api/clients', {
    method: 'POST', headers: { cookie: A.cookie, 'content-type': 'text/plain' }, body: '{}' }));
  assert.equal(noJson.status, 415);
  const cross = await call('POST', '/clients', { cookie: A.cookie, body: {}, headers: { origin: 'https://evil.example', host: 'localhost' } });
  assert.equal(cross.status, 403);
});

test('me: returns tenant config from the preset', { skip }, async () => {
  assert.equal(A.me.business.name, `Test ${A.slug}`);
  assert.equal(A.me.job_types.length, 3);
  assert.deepEqual(A.me.statuses.map((s) => s.label), ['Quoted', 'Scheduled', 'Done', 'Paid']);
  assert.equal(A.me.business.terms.client, 'Client');
});

test('lookup: NEW for unknown number; three formats resolve to the same EXISTING client', { skip }, async () => {
  const none = await call('GET', `/lookup?q=${PHONE}`, { cookie: A.cookie });
  assert.equal(none.data.mode, 'full');
  assert.equal(none.data.matches.length, 0);

  const jt = A.me.job_types.find((t) => t.name === 'Repair');
  const made = await call('POST', '/clients', { cookie: A.cookie, body: { name: 'Pat Rancher', phone: '(979) 555-1234', job: { job_type_id: jt.id } } });
  assert.equal(made.status, 201);
  assert.equal(made.data.client.phone_digits, PHONE);
  assert.equal(made.data.client.jobs[0].status_label, 'Quoted'); // default = first status

  const ids = new Set();
  for (const q of ['(979) 555-1234', '979-555-1234', '+1 979 555 1234']) {
    const r = await call('GET', `/lookup?q=${encodeURIComponent(q)}`, { cookie: A.cookie });
    assert.equal(r.data.matches.length, 1, q);
    ids.add(r.data.matches[0].id);
    assert.equal(r.data.matches[0].job_count, 1);
    assert.equal(r.data.matches[0].last_job_type, 'Repair');
    assert.equal(r.data.matches[0].last_job_status, 'Quoted');
    assert.ok(r.data.matches[0].last_job_at);
  }
  assert.equal(ids.size, 1);
});

test('lookup: last-4 returns a short list when several clients match', { skip }, async () => {
  await call('POST', '/clients', { cookie: A.cookie, body: { name: 'Sam Second', phone: '2145551234' } });
  const r = await call('GET', '/lookup?q=1234', { cookie: A.cookie });
  assert.equal(r.data.mode, 'last4');
  assert.equal(r.data.matches.length, 2);
  assert.equal((await call('GET', '/lookup?q=979', { cookie: A.cookie })).data.mode, 'partial');
});

test('create client: same number never creates a duplicate; replays are idempotent', { skip }, async () => {
  const clientId = randomUUID(), jobId = randomUUID();
  const jt = A.me.job_types[0].id;
  const body = { id: clientId, name: 'Offline Olly', phone: '979-555-7777', job: { id: jobId, job_type_id: jt } };
  const first = await call('POST', '/clients', { cookie: A.cookie, body });
  const replay = await call('POST', '/clients', { cookie: A.cookie, body });
  assert.equal(first.status, 201);
  assert.equal(replay.status, 200);
  assert.equal(replay.data.created, false);
  assert.equal(replay.data.client.id, clientId);
  assert.equal(replay.data.client.jobs.length, 1); // job not duplicated
  // Different formatting + new name, same phone: attaches to the existing client, no 2nd row.
  const other = await call('POST', '/clients', { cookie: A.cookie, body: { name: 'Someone Else', phone: '+1 (979) 555-7777' } });
  assert.equal(other.data.client.id, clientId);
  const { rows } = await pool.query('select count(*)::int c from clients where business_id = $1 and phone_digits = $2', [A.biz.id, '9795557777']);
  assert.equal(rows[0].c, 1);
});

test('validation: bad phone, missing name, oversize and odd input are rejected safely', { skip }, async () => {
  const post = (body) => call('POST', '/clients', { cookie: A.cookie, body });
  assert.equal((await post({ name: 'X', phone: '555-1234' })).status, 400);
  assert.equal((await post({ phone: PHONE })).status, 400);
  assert.equal((await post({ name: 'x'.repeat(500), phone: '9795550000' })).status, 400);
  assert.equal((await post({ name: 'Bad Job', phone: '9795550001', job: { job_type_id: 'nope' } })).status, 400);
  const inj = await post({ name: `Robert'); drop table clients;--`, phone: '9795550002' });
  assert.equal(inj.status, 201); // stored as plain text
  assert.equal((await call('GET', `/lookup?q=${encodeURIComponent("1234' or '1'='1")}`, { cookie: A.cookie })).data.mode, 'partial');
  assert.equal((await pool.query('select count(*)::int c from clients')).rows[0].c > 0, true);
});

test('jobs: add a job, change status with one call, patch client notes', { skip }, async () => {
  const c = (await call('GET', `/lookup?q=${PHONE}`, { cookie: A.cookie })).data.matches[0];
  const jt = A.me.job_types.find((t) => t.name === 'Fence Installation').id;
  const job = await call('POST', `/clients/${c.id}/jobs`, { cookie: A.cookie, body: { job_type_id: jt, notes: '150ft cedar' } });
  assert.equal(job.status, 201);
  const done = A.me.statuses.find((s) => s.key === 'done').id;
  const upd = await call('PATCH', `/jobs/${job.data.job.id}`, { cookie: A.cookie, body: { status_id: done } });
  assert.equal(upd.data.job.status_label, 'Done');
  const card = await call('PATCH', `/clients/${c.id}`, { cookie: A.cookie, body: { notes: 'Gate code 4411', address: '12 Farm Rd, Bryan TX' } });
  assert.equal(card.data.client.notes, 'Gate code 4411');
  assert.equal(card.data.client.jobs.length, 2);
  assert.equal(card.data.client.name, 'Pat Rancher'); // untouched fields stay
});

test('ISOLATION: business B can never see or modify business A data', { skip }, async () => {
  const a = (await call('GET', `/lookup?q=${PHONE}`, { cookie: A.cookie })).data.matches[0];
  const aCard = (await call('GET', `/clients/${a.id}`, { cookie: A.cookie })).data.client;
  const aJob = aCard.jobs[0];
  const aType = A.me.job_types[0].id, aStatus = A.me.statuses[2].id;

  // read
  assert.equal((await call('GET', `/clients/${a.id}`, { cookie: B.cookie })).status, 404);
  assert.equal((await call('GET', `/lookup?q=${PHONE}`, { cookie: B.cookie })).data.matches.length, 0);
  assert.equal((await call('GET', '/lookup?q=1234', { cookie: B.cookie })).data.matches.length, 0);
  // write: every attempt is a 404 / 400 and A's data is unchanged
  assert.equal((await call('PATCH', `/clients/${a.id}`, { cookie: B.cookie, body: { name: 'HACKED', notes: 'HACKED' } })).status, 404);
  assert.equal((await call('PATCH', `/jobs/${aJob.id}`, { cookie: B.cookie, body: { status_id: B.me.statuses[3].id } })).status, 404);
  assert.equal((await call('POST', `/clients/${a.id}/jobs`, { cookie: B.cookie, body: { job_type_id: B.me.job_types[0].id } })).status, 404);
  // B cannot use A's job type / status ids
  assert.equal((await call('POST', '/clients', { cookie: B.cookie, body: { name: 'X', phone: '9795559999', job: { job_type_id: aType } } })).status, 400);
  assert.equal((await call('POST', '/clients', { cookie: B.cookie, body: { name: 'X', phone: '9795559998', job: { job_type_id: B.me.job_types[0].id, status_id: aStatus } } })).status, 400);
  // A job id that belongs to A can't be hijacked through B's create (replayed id is not returned)
  const hijack = await call('POST', `/clients`, { cookie: B.cookie, body: { name: 'H', phone: '9795559997', job: { id: aJob.id, job_type_id: B.me.job_types[0].id } } });
  assert.ok(![].concat(hijack.data?.client?.jobs ?? []).some((j) => j.id === aJob.id));
  // tenant supplied by the client is ignored
  const spoof = await call('POST', '/clients', { cookie: B.cookie, body: { name: 'Spoof', phone: '9795559996', business_id: A.biz.id } });
  assert.equal(spoof.status, 201);
  const { rows } = await pool.query('select business_id from clients where id = $1', [spoof.data.client.id]);
  assert.equal(rows[0].business_id, B.biz.id);

  // A's data is exactly as before
  const after = (await call('GET', `/clients/${a.id}`, { cookie: A.cookie })).data.client;
  assert.equal(after.name, aCard.name);
  assert.equal(after.notes, aCard.notes);
  assert.equal(after.jobs.find((j) => j.id === aJob.id).status_id, aJob.status_id);

  // same phone in both tenants = two independent clients
  const bOwn = await call('POST', '/clients', { cookie: B.cookie, body: { name: 'B Version', phone: PHONE } });
  assert.equal(bOwn.status, 201);
  assert.notEqual(bOwn.data.client.id, a.id);
  assert.equal((await call('GET', `/lookup?q=${PHONE}`, { cookie: A.cookie })).data.matches[0].name, 'Pat Rancher');
});

test('export: own data only, JSON + CSV, formula-injection safe, needs a session', { skip }, async () => {
  const jt = A.me.job_types[0].id;
  await call('POST', '/clients', { cookie: A.cookie, body: { name: '=HYPERLINK("http://x")', phone: '9795558801', notes: 'line1\nline2, "quoted"', job: { job_type_id: jt } } });
  assert.equal((await call('GET', '/export?format=csv')).status, 401);
  assert.equal((await call('GET', '/export?format=xml', { cookie: A.cookie })).status, 400);

  const res = await handle(new Request('http://localhost/api/export?format=csv', { headers: { cookie: A.cookie } }));
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /attachment; filename=".*\.csv"/);
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], "UTF-8 BOM so Excel reads it correctly");
  const csv = bytes.toString("utf8");
  assert.ok(csv.includes("client_name,client_phone"));
  assert.ok(csv.includes(`"'=HYPERLINK(""http://x"")"`), 'formula neutralized + quotes escaped');
  assert.ok(csv.includes('"line1\nline2, ""quoted"""'), 'commas/newlines/quotes quoted');
  assert.ok(csv.includes('(979) 555-8801'));

  const json = await (await handle(new Request('http://localhost/api/export', { headers: { cookie: A.cookie } }))).json();
  assert.equal(json.business.slug, A.slug);
  assert.ok(json.clients.some((c) => c.phone_digits === '9795558801' && c.jobs.length === 1));
  assert.equal(json.business.pin_hash, undefined);

  const other = await (await handle(new Request('http://localhost/api/export', { headers: { cookie: B.cookie } }))).json();
  assert.equal(other.business.slug, B.slug);
  assert.ok(!other.clients.some((c) => c.phone_digits === '9795558801'), "B's export never contains A's clients");
});
