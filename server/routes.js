// Tenant-scoped JSON API. Every handler gets `businessId` from the SESSION (server-side),
// never from the request body, query string, or URL. Every SQL statement filters on it.
import { query } from './db.js';
import { HttpError, json, readJson, assertSameOrigin, clientIp } from './http.js';
import { login, logout, requireSession } from './auth.js';
import { uuid, str } from './validate.js';
import { normalizePhone, parseLookup } from '../shared/phone.js';

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

const JOBS_SQL = `
  select j.id, j.client_id, j.job_type_id, jt.name as job_type, j.status_id,
         s.key as status_key, s.label as status_label, j.notes, j.created_at, j.updated_at
    from jobs j
    join job_types jt on jt.business_id = j.business_id and jt.id = j.job_type_id
    join statuses  s  on s.business_id  = j.business_id and s.id  = j.status_id`;

async function getClient(businessId, id) {
  const [client] = await query(
    `select id, name, phone_digits, address, notes, created_at, updated_at
       from clients where business_id = $1 and id = $2`, [businessId, id]);
  if (!client) return null;
  client.jobs = await query(`${JOBS_SQL} where j.business_id = $1 and j.client_id = $2 order by j.created_at desc`,
    [businessId, id]);
  return client;
}

async function getJob(businessId, id) {
  return (await query(`${JOBS_SQL} where j.business_id = $1 and j.id = $2`, [businessId, id]))[0] ?? null;
}

/** Validate a job payload against THIS business's job types / statuses. Returns clean ids. */
async function cleanJob(businessId, raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(400, 'job must be an object', { field: 'job' });
  const id = uuid(raw.id, 'job.id', { optional: true });
  const jobTypeId = uuid(raw.job_type_id, 'job.job_type_id');
  const statusId = uuid(raw.status_id, 'job.status_id', { optional: true });
  const notes = str(raw.notes, 'job.notes', { max: 4000, optional: true });
  const [r] = await query(
    `select (select id from job_types where business_id = $1 and id = $2 and active) as jt,
            (select id from statuses  where business_id = $1 and id = coalesce($3::uuid,
               (select id from statuses where business_id = $1 order by sort_order limit 1))) as st`,
    [businessId, jobTypeId, statusId]);
  if (!r.jt) throw new HttpError(400, 'Unknown job type', { field: 'job.job_type_id' });
  if (!r.st) throw new HttpError(400, 'Unknown status', { field: 'job.status_id' });
  return { id, jobTypeId: r.jt, statusId: r.st, notes };
}

// ---- handlers ---------------------------------------------------------------------------

async function me({ businessId }) {
  const [b] = await query(
    `select name, slug, phone_digits, city, state, accent_color, terms from businesses where id = $1`, [businessId]);
  const job_types = await query(
    'select id, name from job_types where business_id = $1 and active order by sort_order, name', [businessId]);
  const statuses = await query(
    'select id, key, label, color from statuses where business_id = $1 order by sort_order', [businessId]);
  return json({ business: b, job_types, statuses });
}

async function lookup({ businessId }, url) {
  const parsed = parseLookup(url.searchParams.get('q') || '');
  if (parsed.mode === 'partial') return json({ mode: 'partial', matches: [] });
  const value = parsed.mode === 'full' ? parsed.digits : parsed.last4;
  const cond = parsed.mode === 'full' ? 'c.phone_digits = $2' : 'right(c.phone_digits, 4) = $2';
  const matches = await query(
    `select c.id, c.name, c.phone_digits, c.address,
            (select count(*)::int from jobs x where x.business_id = c.business_id and x.client_id = c.id) as job_count,
            lj.created_at as last_job_at, jt.name as last_job_type, s.label as last_job_status
       from clients c
       left join lateral (select * from jobs x where x.business_id = c.business_id and x.client_id = c.id
                          order by x.created_at desc limit 1) lj on true
       left join job_types jt on jt.business_id = lj.business_id and jt.id = lj.job_type_id
       left join statuses  s  on s.business_id  = lj.business_id and s.id  = lj.status_id
      where c.business_id = $1 and ${cond}
      order by c.name limit 10`, [businessId, value]);
  return json({ mode: parsed.mode, matches });
}

/**
 * Create a client (+ optional first job). Idempotent for offline sync replays:
 *  - the same phone in this business never creates a second client (unique constraint + ON CONFLICT);
 *    instead the existing client is returned with created:false and the job is attached to it;
 *  - a client-supplied job id that already exists is not inserted twice.
 */
async function createClient({ businessId }, req) {
  const b = await readJson(req);
  const id = uuid(b.id, 'id', { optional: true });
  const name = str(b.name, 'name', { max: 120 });
  const phone = normalizePhone(b.phone);
  if (!phone) throw new HttpError(400, 'Enter a valid 10-digit phone number', { field: 'phone' });
  const address = str(b.address, 'address', { max: 300, optional: true });
  const notes = str(b.notes, 'notes', { max: 4000, optional: true });
  const job = b.job == null ? null : await cleanJob(businessId, b.job);

  const [r] = await query(
    `with ins as (
       insert into clients (id, business_id, name, phone_digits, address, notes)
       values (coalesce($1::uuid, gen_random_uuid()), $2::uuid, $3, $4, $5, $6)
       on conflict (business_id, phone_digits) do nothing
       returning id
     ), c as (
       select id, true as created from ins
       union all
       select id, false from clients where business_id = $2::uuid and phone_digits = $4
          and not exists (select 1 from ins)
     ), j as (
       insert into jobs (id, business_id, client_id, job_type_id, status_id, notes)
       select coalesce($7::uuid, gen_random_uuid()), $2::uuid, c.id, $8::uuid, $9::uuid, $10
         from c where $8::uuid is not null
       on conflict (id) do nothing
       returning id
     )
     select c.id, c.created, (select id from j) as job_id from c`,
    [id, businessId, name, phone, address, notes, job?.id ?? null, job?.jobTypeId ?? null, job?.statusId ?? null, job?.notes ?? null]);

  const client = await getClient(businessId, r.id);
  return json({ created: r.created, client }, r.created ? 201 : 200);
}

async function getClientRoute({ businessId }, id) {
  const client = await getClient(businessId, uuid(id, 'id'));
  if (!client) throw new HttpError(404, 'Not found');
  return json({ client });
}

async function patchClient({ businessId }, id, req) {
  const cid = uuid(id, 'id');
  const b = await readJson(req);
  const name = has(b, 'name') ? str(b.name, 'name', { max: 120 }) : null;
  const address = has(b, 'address') ? str(b.address, 'address', { max: 300, optional: true }) : null;
  const notes = has(b, 'notes') ? str(b.notes, 'notes', { max: 4000, optional: true }) : null;
  const rows = await query(
    `update clients set
        name    = case when $3 then $4 else name end,
        address = case when $5 then $6 else address end,
        notes   = case when $7 then $8 else notes end
      where business_id = $1 and id = $2 returning id`,
    [businessId, cid, has(b, 'name'), name, has(b, 'address'), address, has(b, 'notes'), notes]);
  if (!rows.length) throw new HttpError(404, 'Not found');
  return json({ client: await getClient(businessId, cid) });
}

async function addJob({ businessId }, clientId, req) {
  const cid = uuid(clientId, 'id');
  const exists = await query('select 1 from clients where business_id = $1 and id = $2', [businessId, cid]);
  if (!exists.length) throw new HttpError(404, 'Not found');
  const job = await cleanJob(businessId, await readJson(req));
  const rows = await query(
    `insert into jobs (id, business_id, client_id, job_type_id, status_id, notes)
     values (coalesce($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6)
     on conflict (id) do nothing returning id`,
    [job.id, businessId, cid, job.jobTypeId, job.statusId, job.notes]);
  // A replayed job id returns the existing job (scoped to this business) with 200.
  const saved = rows.length ? await getJob(businessId, rows[0].id) : (job.id && await getJob(businessId, job.id));
  if (!saved) throw new HttpError(409, 'Job id already in use');
  return json({ created: rows.length > 0, job: saved }, rows.length ? 201 : 200);
}

async function setStatus({ businessId }, jobId, req) {
  const jid = uuid(jobId, 'id');
  const statusId = uuid((await readJson(req)).status_id, 'status_id');
  const ok = await query('select 1 from statuses where business_id = $1 and id = $2', [businessId, statusId]);
  if (!ok.length) throw new HttpError(400, 'Unknown status', { field: 'status_id' });
  const rows = await query(
    'update jobs set status_id = $3 where business_id = $1 and id = $2 returning id', [businessId, jid, statusId]);
  if (!rows.length) throw new HttpError(404, 'Not found');
  return json({ job: await getJob(businessId, jid) });
}

// ---- router -----------------------------------------------------------------------------

const ID = '([0-9a-fA-F-]{36})';
const ROUTES = [
  ['GET',   /^\/me$/,                            (s, m, url, req) => me(s)],
  ['GET',   /^\/lookup$/,                        (s, m, url) => lookup(s, url)],
  ['POST',  /^\/clients$/,                       (s, m, url, req) => createClient(s, req)],
  ['GET',   new RegExp(`^/clients/${ID}$`),      (s, m) => getClientRoute(s, m[1])],
  ['PATCH', new RegExp(`^/clients/${ID}$`),      (s, m, url, req) => patchClient(s, m[1], req)],
  ['POST',  new RegExp(`^/clients/${ID}/jobs$`), (s, m, url, req) => addJob(s, m[1], req)],
  ['PATCH', new RegExp(`^/jobs/${ID}$`),         (s, m, url, req) => setStatus(s, m[1], req)],
];

export async function handle(req, context) {
  try {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/api/, '').replace(/\/+$/, '') || '/';
    const method = req.method.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') assertSameOrigin(req);

    if (path === '/login' && method === 'POST') return await login(req, clientIp(req, context));
    if (path === '/logout' && method === 'POST') return await logout(req);

    const matched = ROUTES.filter(([, re]) => re.test(path));
    if (!matched.length) throw new HttpError(404, 'Not found');
    const route = matched.find(([m]) => m === method);
    if (!route) throw new HttpError(405, 'Method not allowed');

    const session = await requireSession(req);
    return await route[2](session, path.match(route[1]), url, req);
  } catch (e) {
    if (e instanceof HttpError) {
      return json({ error: e.message, ...e.extra }, e.status, e.status === 429 ? { 'retry-after': '900' } : {});
    }
    if (e?.code === '23503') return json({ error: 'Invalid reference' }, 400);
    if (e?.code === '23505') return json({ error: 'Already exists' }, 409);
    if (e?.code === '22P02' || e?.code === '22001') return json({ error: 'Invalid input' }, 400);
    console.error('API error:', String(e?.message ?? e).split(process.env.DATABASE_URL || '\0').join('[redacted]'));
    return json({ error: 'Server error' }, 500);
  }
}
