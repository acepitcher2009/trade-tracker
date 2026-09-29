// Integration tests: call the API handler directly against the Neon DEV branch using
// throwaway tenants (zz-test-*) that are deleted afterwards. Never touches real tenants.
import './guard.js';
import '../scripts/lib/env.js';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { handle } from '../server/routes.js';
import { getPool } from '../scripts/lib/db.js';
import { createBusiness } from '../scripts/lib/tenant.js';
import { normalizePhone } from '../shared/phone.js';

const skip = !process.env.DATABASE_URL && 'DATABASE_URL not set';
const pool = skip ? null : getPool();
const rnd = () => randomBytes(3).toString('hex');
const pinOf = () => String(Math.floor(100000 + Math.random() * 899999));

// The old server-side phone lookup was retired (the app searches its own copy); tests find clients through the same
// bulk download the app uses, which is tenant-scoped exactly like everything else.
async function lookupCompat(path, opts) {
  const q = decodeURIComponent(path.split('q=')[1] ?? '');
  const digits = q.replace(/\D/g, '');
  const full = normalizePhone(digits);
  const mode = full ? 'full' : digits.length === 4 ? 'last4' : 'partial';
  const r = await call('GET', '/sync', opts);
  if (r.status !== 200) return r;
  if (mode === 'partial') return { status: 200, data: { mode, matches: [] } };
  const types = new Map(r.data.config.job_types_all.map((t) => [t.id, t.name])), statuses = new Map(r.data.config.statuses.map((x) => [x.id, x.label]));
  const matches = r.data.clients.filter((c) => (mode === 'full' ? c.phone_digits === full : c.phone_digits.endsWith(digits))).map((c) => {
    const js = r.data.jobs.filter((j) => j.client_id === c.id).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    return { ...c, job_count: js.length, last_job_type: js[0] ? types.get(js[0].job_type_id) : null, last_job_status: js[0] ? statuses.get(js[0].status_id) : null, last_job_at: js[0]?.created_at ?? null };
  });
  return { status: 200, data: { mode, matches } };
}

async function call(method, path, { body, cookie, headers = {}, ip = '10.0.0.1' } = {}) {
  if (method === 'GET' && path.startsWith('/lookup')) return lookupCompat(path, { cookie, headers, ip });
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
const ADDR = { address_line: '1204 Live Oak Dr', city: 'Bryan', state: 'TX', zip: '77802' };

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
  assert.deepEqual(A.me.statuses.map((s) => s.label), ['New', 'Visit', 'Quoted', 'Accepted', 'Scheduled', 'Done', 'Paid']);
  assert.equal(A.me.business.terms.client, 'Client');
});

test('finding a client by phone: NEW for unknown number; three formats resolve to the same EXISTING client', { skip }, async () => {
  const none = await call('GET', `/lookup?q=${PHONE}`, { cookie: A.cookie });
  assert.equal(none.data.mode, 'full');
  assert.equal(none.data.matches.length, 0);

  const jt = A.me.job_types.find((t) => t.name === 'Repair');
  const made = await call('POST', '/clients', { cookie: A.cookie, body: { ...ADDR, name: 'Pat Rancher', phone: '(979) 555-1234', job: { job_type_id: jt.id } } });
  assert.equal(made.status, 201);
  assert.equal(made.data.client.phone_digits, PHONE);
  assert.equal(made.data.client.jobs[0].status_label, 'New'); // default = first status

  const ids = new Set();
  for (const q of ['(979) 555-1234', '979-555-1234', '+1 979 555 1234']) {
    const r = await call('GET', `/lookup?q=${encodeURIComponent(q)}`, { cookie: A.cookie });
    assert.equal(r.data.matches.length, 1, q);
    ids.add(r.data.matches[0].id);
    assert.equal(r.data.matches[0].job_count, 1);
    assert.equal(r.data.matches[0].last_job_type, 'Repair');
    assert.equal(r.data.matches[0].last_job_status, 'New');
    assert.ok(r.data.matches[0].last_job_at);
  }
  assert.equal(ids.size, 1);
});

test('finding a client by phone: last-4 returns a short list when several clients match', { skip }, async () => {
  await call('POST', '/clients', { cookie: A.cookie, body: { ...ADDR, name: 'Sam Second', phone: '2145551234' } });
  const r = await call('GET', '/lookup?q=1234', { cookie: A.cookie });
  assert.equal(r.data.mode, 'last4');
  assert.equal(r.data.matches.length, 2);
  assert.equal((await call('GET', '/lookup?q=979', { cookie: A.cookie })).data.mode, 'partial');
});

test('create client: same number never creates a duplicate; replays are idempotent', { skip }, async () => {
  const clientId = randomUUID(), jobId = randomUUID();
  const jt = A.me.job_types[0].id;
  const body = { ...ADDR, id: clientId, name: 'Offline Olly', phone: '979-555-7777', job: { id: jobId, job_type_id: jt } };
  const first = await call('POST', '/clients', { cookie: A.cookie, body });
  const replay = await call('POST', '/clients', { cookie: A.cookie, body });
  assert.equal(first.status, 201);
  assert.equal(replay.status, 200);
  assert.equal(replay.data.created, false);
  assert.equal(replay.data.client.id, clientId);
  assert.equal(replay.data.client.jobs.length, 1); // job not duplicated
  // Different formatting + new name, same phone: attaches to the existing client, no 2nd row.
  const other = await call('POST', '/clients', { cookie: A.cookie, body: { ...ADDR, name: 'Someone Else', phone: '+1 (979) 555-7777' } });
  assert.equal(other.data.client.id, clientId);
  const { rows } = await pool.query('select count(*)::int c from clients where business_id = $1 and phone_digits = $2', [A.biz.id, '9795557777']);
  assert.equal(rows[0].c, 1);
});

test('validation: bad phone, missing name, oversize and odd input are rejected safely', { skip }, async () => {
  const post = (body) => call('POST', '/clients', { cookie: A.cookie, body });
  assert.equal((await post({ ...ADDR, name: 'X', phone: '555-1234' })).status, 400);
  assert.equal((await post({ phone: PHONE })).status, 400);
  assert.equal((await post({ ...ADDR, name: 'x'.repeat(500), phone: '9795550000' })).status, 400);
  assert.equal((await post({ ...ADDR, name: 'Bad Job', phone: '9795550001', job: { job_type_id: 'nope' } })).status, 400);
  const inj = await post({ ...ADDR, name: `Robert'); drop table clients;--`, phone: '9795550002' });
  assert.equal(inj.status, 201); // stored as plain text
  // a full address is required: house number + street, city, state, 5-digit ZIP
  const noAddr = { name: 'No Addr', phone: '9795550010' };
  assert.equal((await post(noAddr)).status, 400);
  for (const bad of [{ address_line: 'Live Oak Dr' }, { address_line: '1204' }, { city: '' }, { state: 'ZZ' }, { zip: '778' }, { zip: '77802-1234' }]) {
    const r = await post({ ...ADDR, ...noAddr, ...bad });
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.ok(r.data.field, JSON.stringify(bad));
  }
  const ok = await post({ ...ADDR, ...noAddr, address_line: '  88   County Rd 312 ', state: 'tx' });
  assert.equal(ok.status, 201);
  assert.equal(ok.data.client.address, '88 County Rd 312, Bryan, TX 77802'); // tidied, upper-cased, one-line form
  assert.equal(ok.data.client.address_complete, true);
  // edits keep all four parts together
  assert.equal((await call('PATCH', `/clients/${ok.data.client.id}`, { cookie: A.cookie, body: { city: 'Caldwell' } })).status, 400);
  const moved = await call('PATCH', `/clients/${ok.data.client.id}`, { cookie: A.cookie, body: { address_line: '9 Farm Rd', city: 'Caldwell', state: 'TX', zip: '77836' } });
  assert.equal(moved.data.client.address, '9 Farm Rd, Caldwell, TX 77836');
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
  const card = await call('PATCH', `/clients/${c.id}`, { cookie: A.cookie, body: { notes: 'Gate code 4411', address_line: '12 Farm Rd', city: 'Bryan', state: 'TX', zip: '77803' } });
  assert.equal(card.data.client.notes, 'Gate code 4411');
  assert.equal(card.data.client.jobs.length, 2);
  assert.equal(card.data.client.name, 'Pat Rancher'); // untouched fields stay
});

test('scheduling: date/time on create and update, validation, clearing, and status-only changes keep the date', { skip }, async () => {
  const jt = A.me.job_types[0].id;
  const sched = A.me.statuses.find((s) => s.key === 'scheduled').id;
  const done = A.me.statuses.find((s) => s.key === 'done').id;
  const made = await call('POST', '/clients', { cookie: A.cookie, body: { ...ADDR, name: 'Sched Test', phone: '9795550188',
    job: { job_type_id: jt, status_id: sched, scheduled_date: '2026-10-31', scheduled_time: '09:30' } } });
  assert.equal(made.status, 201);
  const job = made.data.client.jobs[0];
  assert.equal(job.scheduled_date, '2026-10-31');
  assert.equal(job.scheduled_time, '09:30');
  // bad inputs are 400s
  for (const bad of [{ scheduled_date: '2026-02-30' }, { scheduled_date: 'tomorrow' }, { scheduled_date: '2026-10-31', scheduled_time: '25:00' }]) {
    assert.equal((await call('PATCH', `/jobs/${job.id}`, { cookie: A.cookie, body: bad })).status, 400);
  }
  // status-only change keeps the date
  const moved = await call('PATCH', `/jobs/${job.id}`, { cookie: A.cookie, body: { status_id: done } });
  assert.equal(moved.data.job.scheduled_date, '2026-10-31');
  // a date without a time is refused, and so is a time that isn't on the hour or half hour
  assert.equal((await call('PATCH', `/jobs/${job.id}`, { cookie: A.cookie, body: { scheduled_date: '2026-11-02' } })).status, 400);
  assert.equal((await call('PATCH', `/jobs/${job.id}`, { cookie: A.cookie, body: { scheduled_date: '2026-11-02', scheduled_time: '09:15' } })).status, 400);
  assert.equal((await call('POST', '/clients', { cookie: A.cookie, body: { ...ADDR, name: 'No Time', phone: '9795550189', job: { job_type_id: jt, scheduled_date: '2026-11-02' } } })).status, 400);
  const re = await call('PATCH', `/jobs/${job.id}`, { cookie: A.cookie, body: { scheduled_date: '2026-11-02', scheduled_time: '10:30' } });
  assert.equal(re.data.job.scheduled_date, '2026-11-02');
  assert.equal(re.data.job.scheduled_time, '10:30');
  // it shows up in the sync pull, then clears
  const pulled = (await call('GET', '/sync', { cookie: A.cookie })).data.jobs.find((j) => j.id === job.id);
  assert.equal(pulled.scheduled_date, '2026-11-02');
  const cleared = await call('PATCH', `/jobs/${job.id}`, { cookie: A.cookie, body: { scheduled_date: null, scheduled_time: null } });
  assert.equal(cleared.data.job.scheduled_date, null);
  assert.equal((await call('PATCH', `/jobs/${job.id}`, { cookie: A.cookie, body: {} })).status, 400);
});

test('invites: install link is public, single-use when the installed app reports in, and hash-stored', { skip }, async () => {
  const { hashToken } = await import('../server/invites.js');
  const mk = async (token, kind = 'install', days = 7) => pool.query(
    "insert into invites (business_id, token_hash, kind, expires_at) values ($1,$2,$3, now() + ($4 || ' days')::interval)",
    [A.biz.id, hashToken(token), kind, String(days)]);
  const t1 = `zz${rnd()}${rnd()}${rnd()}abcdef`, t2 = `zz${rnd()}${rnd()}${rnd()}ghijkl`, tExp = `zz${rnd()}${rnd()}${rnd()}mnopqr`;
  await mk(t1); await mk(t2, 'browser'); await mk(tExp, 'install', -1);

  // no session needed; answers describe only the business on the invite
  const ok = await call('GET', `/invite/${t1}`);
  assert.deepEqual([ok.status, ok.data.valid, ok.data.kind, ok.data.business.name], [200, true, 'install', `Test ${A.slug}`]);
  assert.equal(ok.data.business.slug, undefined);
  // unknown, malformed and expired tokens are indistinguishable
  for (const bad of [`zz${rnd()}${rnd()}${rnd()}nothere`, 'short', tExp]) assert.deepEqual((await call('GET', `/invite/${bad}`)).data, { valid: false });

  // manifest carries the token in start_url, only while the invite is live
  const man = await call('GET', `/manifest?i=${t1}`);
  assert.equal(man.status, 200); assert.equal(man.data.start_url, `/?i=${t1}`); assert.equal(man.data.display, 'standalone');
  assert.equal((await call('GET', `/manifest?i=${tExp}`)).status, 404);

  // the installed app's first launch uses the invite up and gets the business id to pre-fill
  const used = await call('POST', `/invite/${t1}/consume`, { body: {} });
  assert.deepEqual([used.data.consumed, used.data.slug], [true, A.slug]);
  assert.deepEqual((await call('POST', `/invite/${t1}/consume`, { body: {} })).data, { consumed: false });
  assert.deepEqual((await call('GET', `/invite/${t1}`)).data, { valid: false });
  assert.equal((await call('GET', `/manifest?i=${t1}`)).status, 404);

  // owner-override (browser) links are not used up by opening them
  assert.equal((await call('GET', `/invite/${t2}`)).data.kind, 'browser');
  assert.deepEqual((await call('POST', `/invite/${t2}/consume`, { body: {} })).data, { consumed: false });
  assert.equal((await call('GET', `/invite/${t2}`)).data.valid, true);

  // raw tokens are never stored
  assert.equal((await pool.query('select count(*)::int c from invites where token_hash = $1', [t1])).rows[0].c, 0);
});

test('quotes: save, totals inputs validated, public link shows it, accepting works once, edits reset acceptance', { skip }, async () => {
  const { totals } = await import('../shared/quote.js');
  const jt = A.me.job_types[0].id;
  const made = await call('POST', '/clients', { cookie: A.cookie, body: { ...ADDR, name: 'Quote Test', phone: '9795550177', job: { job_type_id: jt } } });
  const job = made.data.client.jobs[0];
  const token = `zq${rnd()}${rnd()}${rnd()}abcdefgh`;
  const quote = { token, items: [{ name: '6 ft cedar privacy fence', unit: 'ft', qty: 180, unit_price_cents: 3200 }, { name: 'Walk gate', unit: 'each', qty: 1, unit_price_cents: 28500 }],
    tax_bps: 825, deposit_pct: 50, valid_until: '2099-12-31', notes: 'Price good for 30 days.' };
  assert.deepEqual(totals(quote), { subtotal: 604500, tax: 49871, total: 654371, deposit: 327186, balance: 327185 });

  // validation
  const put = (q) => call('PUT', `/jobs/${job.id}/quote`, { cookie: A.cookie, body: { quote: q } });
  for (const bad of [{ ...quote, items: [] }, { ...quote, items: [{ name: '', unit: 'ft', qty: 1, unit_price_cents: 1 }] },
    { ...quote, items: [{ name: 'x', unit: 'ft', qty: 0, unit_price_cents: 1 }] }, { ...quote, items: [{ name: 'x', unit: 'ft', qty: 1, unit_price_cents: 1.5 }] },
    { ...quote, tax_bps: 9999 }, { ...quote, deposit_pct: 101 }, { ...quote, valid_until: '2099-02-30' }, { ...quote, token: 'short' }]) {
    assert.equal((await put(bad)).status, 400, JSON.stringify(bad).slice(0, 80));
  }
  const saved = await put(quote);
  assert.equal(saved.status, 200);
  assert.equal(saved.data.job.quote.items.length, 2);

  // public link: no session, shows business + client + quote (without the token), 404 for anything else
  const pub = await call('GET', `/q/${token}`);
  assert.equal(pub.status, 200);
  assert.equal(pub.data.business.name, `Test ${A.slug}`);
  assert.equal(pub.data.client.address, '1204 Live Oak Dr, Bryan, TX 77802');
  assert.equal(pub.data.quote.token, undefined);
  assert.equal(pub.data.accepted_at, null);
  assert.equal((await call('GET', `/q/zz${rnd()}${rnd()}${rnd()}nothere`)).status, 404);

  // accepting needs a name, works once, and shows up on the job
  assert.equal((await call('POST', `/q/${token}/accept`, { body: {} })).status, 400);
  const acc = await call('POST', `/q/${token}/accept`, { body: { name: 'Maria Gonzales', agree: true } });
  assert.equal(acc.data.accepted_by, 'Maria Gonzales');
  const again = await call('POST', `/q/${token}/accept`, { body: { name: 'Someone Else', agree: true } });
  assert.equal(again.data.accepted_by, 'Maria Gonzales');
  const card = (await call('GET', `/clients/${made.data.client.id}`, { cookie: A.cookie })).data.client.jobs[0];
  assert.equal(card.quote_accepted_by, 'Maria Gonzales');
  // marking it "sent" keeps the acceptance; changing the numbers clears it
  await put({ ...quote, sent_at: new Date().toISOString() });
  assert.equal((await call('GET', `/q/${token}`)).data.accepted_by, 'Maria Gonzales');
  await put({ ...quote, deposit_pct: 25 });
  assert.equal((await call('GET', `/q/${token}`)).data.accepted_by, null);
  // an expired quote can't be accepted
  await put({ ...quote, valid_until: '2020-01-01' });
  assert.equal((await call('GET', `/q/${token}`)).data.expired, true);
  assert.equal((await call('POST', `/q/${token}/accept`, { body: { name: 'Late', agree: true } })).status, 410);
  // removing the quote kills the link
  assert.equal((await put(null)).data.job.quote, null);
  assert.equal((await call('GET', `/q/${token}`)).status, 404);
  // another business can't touch it
  assert.equal((await call('PUT', `/jobs/${job.id}/quote`, { cookie: B.cookie, body: { quote } })).status, 404);
});

test('workflow: New > Visit (dated) > Quoted (date dropped) ; accepting moves a job to Accepted, but never backwards', { skip }, async () => {
  const st = Object.fromEntries(A.me.statuses.map((x) => [x.key, x.id]));
  const jt = A.me.job_types[0].id;
  const made = await call('POST', '/clients', { cookie: A.cookie, body: { ...ADDR, name: 'Flow Test', phone: '9795550188', job: { job_type_id: jt } } });
  const job = made.data.client.jobs[0];
  assert.equal(job.status_label, 'New');
  const visit = await call('PATCH', `/jobs/${job.id}`, { cookie: A.cookie, body: { status_id: st.visit, scheduled_date: '2099-01-05', scheduled_time: '10:30' } });
  assert.equal(visit.data.job.status_label, 'Visit');
  assert.equal(visit.data.job.scheduled_time, '10:30');
  const token = `zw${rnd()}${rnd()}${rnd()}abcdefgh`;
  const quote = { token, items: [{ name: 'Walk gate', unit: 'each', qty: 1, unit_price_cents: 28500 }], tax_bps: 825, deposit_pct: 0, valid_until: '2099-12-31', notes: '' };
  assert.equal((await call('PUT', `/jobs/${job.id}/quote`, { cookie: A.cookie, body: { quote } })).status, 200);
  const acc = await call('POST', `/q/${token}/accept`, { body: { name: 'Flow Test', agree: true } });
  assert.equal(acc.status, 200);
  const got = (await call('GET', `/clients/${made.data.client.id}`, { cookie: A.cookie })).data.client.jobs[0];
  assert.equal(got.status_label, 'Accepted');
  assert.equal(got.scheduled_date, null);           // the visit is over
  // once the job is Scheduled, a repeat accept must not pull it back
  await call('PATCH', `/jobs/${job.id}`, { cookie: A.cookie, body: { status_id: st.scheduled, scheduled_date: '2099-01-09', scheduled_time: '08:00' } });
  await call('POST', `/q/${token}/accept`, { body: { name: 'Flow Test', agree: true } });
  assert.equal((await call('GET', `/clients/${made.data.client.id}`, { cookie: A.cookie })).data.client.jobs[0].status_label, 'Scheduled');
});

test('price list: preset seeds it, owner edits are tenant-scoped, tax rate is validated, config carries both', { skip }, async () => {
  const cfg = (await call('GET', '/me', { cookie: A.cookie })).data;
  assert.ok(cfg.catalog.length >= 10);
  assert.equal(cfg.business.tax_rate_bps, 825);
  const fenceType = cfg.job_types.find((t) => t.name === 'Fence Installation').id;
  assert.ok(cfg.catalog.some((c) => c.job_type_id === fenceType));
  const id = randomUUID();
  const add = await call('PUT', `/catalog/${id}`, { cookie: A.cookie, body: { name: 'Custom cap rail', unit: 'ft', unit_price_cents: 550, job_type_id: fenceType } });
  assert.equal(add.status, 200);
  assert.ok(add.data.config.catalog.some((c) => c.id === id && c.unit_price_cents === 550));
  assert.equal((await call('PUT', `/catalog/${id}`, { cookie: A.cookie, body: { name: 'Custom cap rail', unit: 'ft', unit_price_cents: 600 } })).data.config.catalog.find((c) => c.id === id).unit_price_cents, 600);
  assert.equal((await call('PUT', `/catalog/${id}`, { cookie: A.cookie, body: { name: 'x', unit: 'ft', unit_price_cents: -5 } })).status, 400);
  // business B can neither overwrite nor delete A's item, and can't attach A's job type
  assert.equal((await call('PUT', `/catalog/${id}`, { cookie: B.cookie, body: { name: 'HACK', unit: 'ft', unit_price_cents: 1 } })).status, 409);
  assert.equal((await call('DELETE', `/catalog/${id}`, { cookie: B.cookie })).status, 404);
  assert.equal((await call('PUT', `/catalog/${randomUUID()}`, { cookie: B.cookie, body: { name: 'x', unit: 'ft', unit_price_cents: 1, job_type_id: fenceType } })).status, 400);
  assert.equal((await call('DELETE', `/catalog/${id}`, { cookie: A.cookie })).data.config.catalog.some((c) => c.id === id), false);
  // tax
  assert.equal((await call('PATCH', '/business', { cookie: A.cookie, body: { tax_rate_bps: 700 } })).data.config.business.tax_rate_bps, 700);
  assert.equal((await call('PATCH', '/business', { cookie: A.cookie, body: { tax_rate_bps: 5000 } })).status, 400);
  await call('PATCH', '/business', { cookie: A.cookie, body: { tax_rate_bps: 825 } });
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
  assert.equal((await call('PATCH', `/clients/${a.id}`, { cookie: B.cookie, body: { ...ADDR, name: 'HACKED', notes: 'HACKED' } })).status, 404);
  assert.equal((await call('PATCH', `/jobs/${aJob.id}`, { cookie: B.cookie, body: { status_id: B.me.statuses[3].id } })).status, 404);
  assert.equal((await call('POST', `/clients/${a.id}/jobs`, { cookie: B.cookie, body: { job_type_id: B.me.job_types[0].id } })).status, 404);
  // B cannot use A's job type / status ids
  assert.equal((await call('POST', '/clients', { cookie: B.cookie, body: { ...ADDR, name: 'X', phone: '9795559999', job: { job_type_id: aType } } })).status, 400);
  assert.equal((await call('POST', '/clients', { cookie: B.cookie, body: { ...ADDR, name: 'X', phone: '9795559998', job: { job_type_id: B.me.job_types[0].id, status_id: aStatus } } })).status, 400);
  // A job id that belongs to A can't be hijacked through B's create (replayed id is not returned)
  const hijack = await call('POST', `/clients`, { cookie: B.cookie, body: { ...ADDR, name: 'H', phone: '9795559997', job: { id: aJob.id, job_type_id: B.me.job_types[0].id } } });
  assert.ok(![].concat(hijack.data?.client?.jobs ?? []).some((j) => j.id === aJob.id));
  // tenant supplied by the client is ignored
  const spoof = await call('POST', '/clients', { cookie: B.cookie, body: { ...ADDR, name: 'Spoof', phone: '9795559996', business_id: A.biz.id } });
  assert.equal(spoof.status, 201);
  const { rows } = await pool.query('select business_id from clients where id = $1', [spoof.data.client.id]);
  assert.equal(rows[0].business_id, B.biz.id);

  // A's data is exactly as before
  const after = (await call('GET', `/clients/${a.id}`, { cookie: A.cookie })).data.client;
  assert.equal(after.name, aCard.name);
  assert.equal(after.notes, aCard.notes);
  assert.equal(after.jobs.find((j) => j.id === aJob.id).status_id, aJob.status_id);

  // same phone in both tenants = two independent clients
  const bOwn = await call('POST', '/clients', { cookie: B.cookie, body: { ...ADDR, name: 'B Version', phone: PHONE } });
  assert.equal(bOwn.status, 201);
  assert.notEqual(bOwn.data.client.id, a.id);
  assert.equal((await call('GET', `/lookup?q=${PHONE}`, { cookie: A.cookie })).data.matches[0].name, 'Pat Rancher');
});

test('export: own data only, JSON + CSV, formula-injection safe, needs a session', { skip }, async () => {
  const jt = A.me.job_types[0].id;
  await call('POST', '/clients', { cookie: A.cookie, body: { ...ADDR, name: '=HYPERLINK("http://x")', phone: '9795558801', notes: 'line1\nline2, "quoted"', job: { job_type_id: jt } } });
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

test('delete client: removes client + jobs, idempotent, tenant-scoped, syncs as a tombstone, phone reusable', { skip }, async () => {
  const jt = A.me.job_types[0].id;
  const c = await call('POST', '/clients', { cookie: A.cookie, body: { name: 'Gone Guy', phone: '9795550142', ...ADDR, job: { job_type_id: jt } } });
  assert.equal(c.status, 201);
  const id = c.data.client.id;
  const cross = await call('DELETE', `/clients/${id}`, { cookie: B.cookie });
  assert.equal(cross.status, 200); assert.equal(cross.data.deleted, false);
  assert.equal((await call('GET', `/clients/${id}`, { cookie: A.cookie })).status, 200);
  const t0 = new Date(Date.now() - 2000).toISOString();
  const d = await call('DELETE', `/clients/${id}`, { cookie: A.cookie });
  assert.equal(d.status, 200); assert.equal(d.data.deleted, true);
  assert.equal((await call('GET', `/clients/${id}`, { cookie: A.cookie })).status, 404);
  assert.equal((await call('DELETE', `/clients/${id}`, { cookie: A.cookie })).data.deleted, false);
  const q = `/sync?since=${encodeURIComponent(t0)}`;
  assert.ok((await call('GET', q, { cookie: A.cookie })).data.deleted_client_ids.includes(id));
  assert.ok(!(await call('GET', q, { cookie: B.cookie })).data.deleted_client_ids.includes(id));
  const again = await call('POST', '/clients', { cookie: A.cookie, body: { name: 'Back Again', phone: '9795550142', ...ADDR } });
  assert.equal(again.status, 201);
});
