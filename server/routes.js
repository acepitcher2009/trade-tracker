// Tenant-scoped JSON API. Every handler gets `businessId` from the SESSION (server-side),
// never from the request body, query string, or URL. Every SQL statement filters on it.
import { query } from './db.js';
import { HttpError, json, readJson, assertSameOrigin, clientIp } from './http.js';
import { login, logout, logoutAll, requireSession } from './auth.js';
import { uuid, str } from './validate.js';
import { normalizePhone } from '../shared/phone.js';
import { validateAddress } from '../shared/address.js';
import { validateQuote, KINDS } from '../shared/quote.js';
import { publicQuoteGet, publicQuoteAccept, publicQuoteDecline } from './publicQuote.js';
import { loadExport, toCsv } from './export.js';
import { inviteGet, inviteConsume, inviteManifest } from './invites.js';
import { pushKey, pushSubscribe, pushUnsubscribe, pushLatest } from './push.js';

/** 'YYYY-MM-DD' that is a real calendar date, or null. */
function cleanDate(v, field) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))
      || new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) !== v) throw new HttpError(400, `${field} must be a date like 2026-10-31`, { field });
  return v;
}
/** 'HH:MM' 24h, or null. */
function cleanTime(v, field) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || !/^([01]\d|2[0-3]):(00|30)$/.test(v)) throw new HttpError(400, `${field} must be on the hour or half hour, like 09:00 or 09:30`, { field });
  return v;
}

const EVERY = ['week', '2weeks', 'month', 'quarter', 'year'];
/** Recurrence: null or { every }. */
function cleanRecurrence(v, field) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'object' || Array.isArray(v) || !EVERY.includes(v.every)) throw new HttpError(400, 'Pick how often the job repeats.', { field });
  return { every: v.every };
}
function cleanDays(v, field) {
  if (v === undefined || v === null || v === '') return 1;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 60) throw new HttpError(400, 'Days must be between 1 and 60.', { field });
  return n;
}
function cleanAssignee(v, field) { return str(v, field, { max: 60, optional: true }) || null; }

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// Address columns every client read returns: the four parts, a one-line display string (falls back to the
// old free-text address for clients not yet completed), and whether the full address is on file.
const ADDR = (t = '') => `${t}address_line, ${t}city, ${t}state, ${t}zip,
       case when ${t}address_line is not null then ${t}address_line || ', ' || ${t}city || ', ' || ${t}state || ' ' || ${t}zip else ${t}address end as address,
       (${t}address_line is not null) as address_complete`;

function cleanAddress(b) {
  const r = validateAddress({ line: b.address_line, city: b.city, state: b.state, zip: b.zip });
  if (!r.ok) throw new HttpError(400, r.error, { field: r.field });
  return r.value;
}

const JOBS_SQL = `
  select j.id, j.client_id, j.job_type_id, jt.name as job_type, j.status_id,
         s.key as status_key, s.label as status_label, j.notes, j.created_at, j.updated_at,
         j.scheduled_date::text as scheduled_date, to_char(j.scheduled_time, 'HH24:MI') as scheduled_time,
         j.quote, j.quote_accepted_at, j.quote_accepted_by, j.quote_selection, j.quote_accepted_total_cents,
         j.parent_job_id, j.duration_days, j.assigned_to, j.recurrence, j.declined_at, j.decline_reason, j.payments
    from jobs j
    left join job_types jt on jt.business_id = j.business_id and jt.id = j.job_type_id
    join statuses  s  on s.business_id  = j.business_id and s.id  = j.status_id`;

async function getClient(businessId, id) {
  const [client] = await query(
    `select id, name, phone_digits, ${ADDR()}, notes, created_at, updated_at
       from clients where business_id = $1 and id = $2`, [businessId, id]);
  if (!client) return null;
  client.jobs = await query(`${JOBS_SQL} where j.business_id = $1 and j.client_id = $2 and j.deleted_at is null order by j.created_at desc`,
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
  const jobTypeId = uuid(raw.job_type_id, 'job.job_type_id', { optional: true }); // chosen later, in the quote form
  const statusId = uuid(raw.status_id, 'job.status_id', { optional: true });
  const notes = str(raw.notes, 'job.notes', { max: 4000, optional: true });
  const scheduledDate = cleanDate(raw.scheduled_date, 'job.scheduled_date');
  const scheduledTime = scheduledDate ? cleanTime(raw.scheduled_time, 'job.scheduled_time') : null;
  if (scheduledDate && !scheduledTime) throw new HttpError(400, 'Pick a time for the scheduled date', { field: 'job.scheduled_time' });
  const [r] = await query(
    `select (select id from job_types where business_id = $1 and id = $2::uuid and active) as jt,
            (select id from statuses  where business_id = $1 and id = coalesce($3::uuid,
               (select id from statuses where business_id = $1 order by sort_order limit 1))) as st`,
    [businessId, jobTypeId, statusId]);
  if (jobTypeId && !r.jt) throw new HttpError(400, 'Unknown job type', { field: 'job.job_type_id' });
  if (!r.st) throw new HttpError(400, 'Unknown status', { field: 'job.status_id' });
  const durationDays = cleanDays(raw.duration_days, 'job.duration_days');
  const assignedTo = cleanAssignee(raw.assigned_to, 'job.assigned_to');
  const recurrence = cleanRecurrence(raw.recurrence, 'job.recurrence');
  const parentJobId = uuid(raw.parent_job_id, 'job.parent_job_id', { optional: true });
  if (parentJobId) {
    const ok = await query('select 1 from jobs where business_id = $1 and id = $2', [businessId, parentJobId]);
    if (!ok.length) throw new HttpError(400, 'Unknown original job', { field: 'job.parent_job_id' });
  }
  return { id, jobTypeId: r.jt, statusId: r.st, notes, scheduledDate, scheduledTime, durationDays, assignedTo,
           recurrence: recurrence ? JSON.stringify(recurrence) : null, parentJobId };
}

// ---- handlers ---------------------------------------------------------------------------

async function getConfig(businessId) {
  const [business] = await query(
    `select name, slug, preset, phone_digits, city, state, accent_color, terms, tax_rate_bps, license_no, quote_terms, min_charge_cents,
            uses_visits, default_deposit_pct, valid_days from businesses where id = $1`, [businessId]);
  const job_types_all = await query(
    'select id, name, active from job_types where business_id = $1 order by sort_order, name', [businessId]);
  const statuses = await query(
    'select id, key, label, color from statuses where business_id = $1 order by sort_order', [businessId]);
  const catalog = await query(
    `select id, name, unit, unit_price_cents, job_type_id, kind, unit_cost_cents, taxable from catalog_items
      where business_id = $1 and active order by sort_order, name`, [businessId]);
  return { business, job_types: job_types_all.filter((t) => t.active).map(({ id, name }) => ({ id, name })), job_types_all, statuses, catalog };
}

async function me({ businessId }) {
  return json(await getConfig(businessId));
}

const iso = (v) => new Date(v).toISOString();

/**
 * Bulk pull for the offline cache: everything changed since `since` (or everything).
 * Two lists are paged together; `next_since` is the earliest "last row" of any truncated list so
 * nothing is skipped. Re-delivered rows are harmless (client upserts by id).
 */
async function syncPull({ businessId }, url) {
  const raw = url.searchParams.get('since');
  let since = null;
  if (raw) {
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) throw new HttpError(400, 'Bad since', { field: 'since' });
    // A phone that has been away a very long time gets everything again (deleted-client records are only kept for 90 days).
    if (Date.now() - d.getTime() < 60 * 86400_000) since = d.toISOString();
  }
  const withConfig = url.searchParams.get('config') !== '0' || since === null; // settings rarely change: the app asks for them every few minutes
  const SYNC_LIMIT = Number(process.env.SYNC_PAGE_SIZE) || 5000; // env override exists for tests only
  const [[t], clients, jobs, gone, config] = await Promise.all([
    query('select now() as server_time'),
    query(
      `select id, name, phone_digits, ${ADDR()}, notes, created_at, updated_at from clients
        where business_id = $1 and ($2::timestamptz is null or updated_at >= $2::timestamptz)
        order by updated_at, id limit ${SYNC_LIMIT + 1}`, [businessId, since]),
    query(
      `select id, client_id, job_type_id, status_id, notes, created_at, updated_at,
              scheduled_date::text as scheduled_date, to_char(scheduled_time, 'HH24:MI') as scheduled_time,
              quote, quote_accepted_at, quote_accepted_by, quote_selection, quote_accepted_total_cents,
              parent_job_id, duration_days, assigned_to, recurrence, declined_at, decline_reason, payments, deleted_at from jobs
        where business_id = $1 and ($2::timestamptz is null or updated_at >= $2::timestamptz)
          and ($2::timestamptz is not null or deleted_at is null)
        order by updated_at, id limit ${SYNC_LIMIT + 1}`, [businessId, since]),
    query(
      `select client_id from client_tombstones
        where business_id = $1 and ($2::timestamptz is null or deleted_at >= $2::timestamptz)`, [businessId, since]),
    withConfig ? getConfig(businessId) : Promise.resolve(undefined),
  ]);
  const cut = [];
  for (const rows of [clients, jobs]) {
    if (rows.length > SYNC_LIMIT) { rows.length = SYNC_LIMIT; cut.push(iso(rows[SYNC_LIMIT - 1].updated_at)); }
  }
  cut.sort();
  return json({
    server_time: iso(t.server_time),
    ...(config ? { config } : {}),
    clients, jobs,
    full: since === null, // this is everything: the phone may drop anything not listed
    deleted_client_ids: gone.map((g) => g.client_id),
    more: cut.length > 0,
    next_since: cut[0] ?? null,
  });
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
  const addr = cleanAddress(b); // a full address is required for every new client
  const notes = str(b.notes, 'notes', { max: 4000, optional: true });
  const job = b.job == null ? null : await cleanJob(businessId, b.job);

  const [r] = await query(
    `with ins as (
       insert into clients (id, business_id, name, phone_digits, address_line, city, state, zip, notes)
       values (coalesce($1::uuid, gen_random_uuid()), $2::uuid, $3, $4, $5, $13, $14, $15, $6)
       on conflict (business_id, phone_digits) do nothing
       returning id
     ), c as (
       select id, true as created from ins
       union all
       select id, false from clients where business_id = $2::uuid and phone_digits = $4
          and not exists (select 1 from ins)
     ), j as (
       insert into jobs (id, business_id, client_id, job_type_id, status_id, notes, scheduled_date, scheduled_time, duration_days, assigned_to, recurrence, parent_job_id)
       select coalesce($7::uuid, gen_random_uuid()), $2::uuid, c.id, $8::uuid, $9::uuid, $10, $11::date, $12::time, $16::int, $17, $18::jsonb, $19::uuid
         from c where $20::boolean
       on conflict (id) do nothing
       returning id
     )
     select c.id, c.created, (select id from j) as job_id from c`,
    [id, businessId, name, phone, addr.line, notes, job?.id ?? null, job?.jobTypeId ?? null, job?.statusId ?? null, job?.notes ?? null, job?.scheduledDate ?? null, job?.scheduledTime ?? null, addr.city, addr.state, addr.zip,
     job?.durationDays ?? 1, job?.assignedTo ?? null, job?.recurrence ?? null, job?.parentJobId ?? null, !!job]);

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
  const hasAddr = ['address_line', 'city', 'state', 'zip'].some((k) => has(b, k));
  const addr = hasAddr ? cleanAddress(b) : null; // the four parts travel together
  const notes = has(b, 'notes') ? str(b.notes, 'notes', { max: 4000, optional: true }) : null;
  const rows = await query(
    `update clients set
        name    = case when $3 then $4 else name end,
        address_line = case when $5 then $6 else address_line end,
        city         = case when $5 then $9 else city end,
        state        = case when $5 then $10 else state end,
        zip          = case when $5 then $11 else zip end,
        notes   = case when $7 then $8 else notes end
      where business_id = $1 and id = $2 returning id`,
    [businessId, cid, has(b, 'name'), name, hasAddr, addr?.line ?? null, has(b, 'notes'), notes, addr?.city ?? null, addr?.state ?? null, addr?.zip ?? null]);
  if (!rows.length) throw new HttpError(404, 'Not found');
  return json({ client: await getClient(businessId, cid) });
}

/** Delete a client and all their jobs. Idempotent: deleting something already gone succeeds. */
async function deleteClient({ businessId }, id) {
  const cid = uuid(id, 'id');
  const rows = await query('delete from clients where business_id = $1 and id = $2 returning id', [businessId, cid]);
  if (rows.length) {
    await query(
      `insert into client_tombstones (business_id, client_id) values ($1, $2)
       on conflict (business_id, client_id) do update set deleted_at = now()`, [businessId, cid]);
    // Deleted-client records only matter to phones that sync at least every 60 days (older phones re-download everything).
    await query("delete from client_tombstones where business_id = $1 and deleted_at < now() - interval '90 days'", [businessId]);
  }
  return json({ deleted: rows.length > 0, id: cid });
}

async function addJob({ businessId }, clientId, req) {
  const cid = uuid(clientId, 'id');
  const exists = await query('select 1 from clients where business_id = $1 and id = $2', [businessId, cid]);
  if (!exists.length) throw new HttpError(404, 'Not found');
  const job = await cleanJob(businessId, await readJson(req));
  const rows = await query(
    `insert into jobs (id, business_id, client_id, job_type_id, status_id, notes, scheduled_date, scheduled_time, duration_days, assigned_to, recurrence, parent_job_id)
     values (coalesce($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7::date, $8::time, $9::int, $10, $11::jsonb, $12::uuid)
     on conflict (id) do nothing returning id`,
    [job.id, businessId, cid, job.jobTypeId, job.statusId, job.notes, job.scheduledDate, job.scheduledTime, job.durationDays, job.assignedTo, job.recurrence, job.parentJobId]);
  // A replayed job id returns the existing job (scoped to this business) with 200.
  const saved = rows.length ? await getJob(businessId, rows[0].id) : (job.id && await getJob(businessId, job.id));
  if (!saved) throw new HttpError(409, 'Job id already in use');
  return json({ created: rows.length > 0, job: saved }, rows.length ? 201 : 200);
}

const METHODS = ['cash', 'check', 'card', 'transfer', 'other'];
/** Payments received on a job: a short list, replaced as a whole. */
function cleanPayments(v, field) {
  if (!Array.isArray(v) || v.length > 100) throw new HttpError(400, 'payments must be a list of up to 100 payments', { field });
  return v.map((p) => {
    if (p === null || typeof p !== 'object') throw new HttpError(400, 'Bad payment', { field });
    const amount = Number(p.amount_cents);
    if (!Number.isInteger(amount) || amount < 1 || amount > 100_000_000) throw new HttpError(400, 'A payment must be at least $0.01.', { field });
    const method = METHODS.includes(p.method) ? p.method : 'other';
    const date = cleanDate(p.date, 'payment date');
    if (!date) throw new HttpError(400, 'Pick the date the payment came in.', { field });
    const note = str(p.note, 'payment note', { max: 200, optional: true });
    return { id: uuid(p.id, 'payment id'), amount_cents: amount, method, date, ...(note ? { note } : {}) };
  });
}

/** Change a job: status, schedule, notes, job type, payments received, or delete it. Omitted fields are left alone; null clears a date/time. */
async function setStatus({ businessId }, jobId, req) {
  const jid = uuid(jobId, 'id');
  const b = await readJson(req);
  const hasStatus = has(b, 'status_id'), hasDate = has(b, 'scheduled_date'), hasTime = has(b, 'scheduled_time');
  const hasDays = has(b, 'duration_days'), hasWho = has(b, 'assigned_to'), hasRec = has(b, 'recurrence');
  const hasNotes = has(b, 'notes'), hasType = has(b, 'job_type_id'), hasPay = has(b, 'payments'), del = b.deleted === true;
  if (![hasStatus, hasDate, hasTime, hasDays, hasWho, hasRec, hasNotes, hasType, hasPay, del].some(Boolean)) throw new HttpError(400, 'status_id is required', { field: 'status_id' });
  const statusId = hasStatus ? uuid(b.status_id, 'status_id') : null;
  const date = hasDate ? cleanDate(b.scheduled_date, 'scheduled_date') : null;
  const time = hasTime && (hasDate ? date : true) ? cleanTime(b.scheduled_time, 'scheduled_time') : null;
  if (hasDate && date && !time) throw new HttpError(400, 'Pick a time for the scheduled date', { field: 'scheduled_time' });
  const days = hasDays ? cleanDays(b.duration_days, 'duration_days') : 1;
  const who = hasWho ? cleanAssignee(b.assigned_to, 'assigned_to') : null;
  const rec = hasRec ? cleanRecurrence(b.recurrence, 'recurrence') : null;
  const notes = hasNotes ? str(b.notes, 'notes', { max: 4000, optional: true }) : null;
  const typeId = hasType ? uuid(b.job_type_id, 'job_type_id', { optional: true }) : null;
  const pays = hasPay ? cleanPayments(b.payments, 'payments') : null;
  if (hasStatus) {
    const ok = await query('select 1 from statuses where business_id = $1 and id = $2', [businessId, statusId]);
    if (!ok.length) throw new HttpError(400, 'Unknown status', { field: 'status_id' });
  }
  if (typeId) {
    const ok = await query('select 1 from job_types where business_id = $1 and id = $2', [businessId, typeId]);
    if (!ok.length) throw new HttpError(400, 'Unknown job type', { field: 'job_type_id' });
  }
  const rows = await query(
    `update jobs set
        status_id      = case when $3 then $4::uuid else status_id end,
        scheduled_date = case when $5 then $6::date else scheduled_date end,
        scheduled_time = case when $5 or $7 then $8::time else scheduled_time end,
        duration_days  = case when $9 then $10::int else duration_days end,
        assigned_to    = case when $11 then $12 else assigned_to end,
        recurrence     = case when $13 then $14::jsonb else recurrence end,
        notes          = case when $15 then $16 else notes end,
        job_type_id    = case when $17 then $18::uuid else job_type_id end,
        payments       = case when $19 then $20::jsonb else payments end,
        deleted_at     = case when $21 then coalesce(deleted_at, now()) else deleted_at end
      where business_id = $1 and id = $2 returning id`,
    [businessId, jid, hasStatus, statusId, hasDate, date, hasTime, time, hasDays, days, hasWho, who, hasRec, rec ? JSON.stringify(rec) : null,
     hasNotes, notes, hasType, typeId, hasPay, pays ? JSON.stringify(pays) : null, del]);
  if (!rows.length) {
    if (del) return json({ deleted: true, id: jid }); // deleting something already gone succeeds
    throw new HttpError(404, 'Not found');
  }
  if (del) return json({ deleted: true, id: jid });
  return json({ job: await getJob(businessId, jid) });
}

/** Save (or remove, with null) the job's itemized quote. Changing a quote after it was accepted clears the acceptance. */
async function putQuote({ businessId }, jobId, req) {
  const jid = uuid(jobId, 'id');
  const b = await readJson(req);
  if (!has(b, 'quote')) throw new HttpError(400, 'quote is required', { field: 'quote' });
  let value = null;
  const typeId = uuid(b.job_type_id, 'job_type_id', { optional: true });
  if (typeId) {
    const ok = await query('select 1 from job_types where business_id = $1 and id = $2 and active', [businessId, typeId]);
    if (!ok.length) throw new HttpError(400, 'Unknown job type', { field: 'job_type_id' });
  }
  if (b.quote !== null) {
    if (!typeId) {
      const [cur] = await query('select job_type_id from jobs where business_id = $1 and id = $2', [businessId, jid]);
      if (cur && !cur.job_type_id) throw new HttpError(400, 'Pick what kind of job this is.', { field: 'job_type_id' });
    }
    const r = validateQuote(b.quote);
    if (!r.ok) throw new HttpError(400, r.error, { field: r.field });
    value = JSON.stringify(r.value);
  }
  const rows = await query(
    `update jobs set
        quote_accepted_at = case when $3::jsonb is null or (quote - 'sent_at') is distinct from ($3::jsonb - 'sent_at') then null else quote_accepted_at end,
        quote_accepted_by = case when $3::jsonb is null or (quote - 'sent_at') is distinct from ($3::jsonb - 'sent_at') then null else quote_accepted_by end,
        quote_selection = case when $3::jsonb is null or (quote - 'sent_at') is distinct from ($3::jsonb - 'sent_at') then null else quote_selection end,
        quote_accepted_total_cents = case when $3::jsonb is null or (quote - 'sent_at') is distinct from ($3::jsonb - 'sent_at') then null else quote_accepted_total_cents end,
        quote_accept_meta = case when $3::jsonb is null or (quote - 'sent_at') is distinct from ($3::jsonb - 'sent_at') then null else quote_accept_meta end,
        declined_at = case when $3::jsonb is null or (quote - 'sent_at') is distinct from ($3::jsonb - 'sent_at') then null else declined_at end,
        decline_reason = case when $3::jsonb is null or (quote - 'sent_at') is distinct from ($3::jsonb - 'sent_at') then null else decline_reason end,
        job_type_id = coalesce($4::uuid, job_type_id),
        quote = $3::jsonb
      where business_id = $1 and id = $2 returning id`, [businessId, jid, value, typeId]);
  if (!rows.length) throw new HttpError(404, 'Not found');
  return json({ job: await getJob(businessId, jid) });
}

const dollars = (v, field) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 100_000_000) throw new HttpError(400, 'Price must be $0 or more.', { field });
  return n;
};

/** Price-list edit (owner setup, needs a connection). Idempotent by id; returns the fresh config. */
async function putCatalogItem({ businessId }, id, req) {
  const cid = uuid(id, 'id');
  const b = await readJson(req);
  const name = str(b.name, 'name', { max: 120 });
  const unit = str(b.unit ?? 'each', 'unit', { max: 20 });
  const price = dollars(b.unit_price_cents, 'unit_price_cents');
  const kind = b.kind == null || b.kind === '' ? 'item' : String(b.kind);
  if (!KINDS.includes(kind)) throw new HttpError(400, 'Unknown line type.', { field: 'kind' });
  const cost = b.unit_cost_cents == null || b.unit_cost_cents === '' ? null : dollars(b.unit_cost_cents, 'unit_cost_cents');
  const taxable = b.taxable === undefined ? true : b.taxable;
  if (typeof taxable !== 'boolean') throw new HttpError(400, 'taxable must be true or false', { field: 'taxable' });
  const jt = uuid(b.job_type_id, 'job_type_id', { optional: true });
  if (jt) {
    const ok = await query('select 1 from job_types where business_id = $1 and id = $2', [businessId, jt]);
    if (!ok.length) throw new HttpError(400, 'Unknown job type', { field: 'job_type_id' });
  }
  const rows = await query(
    `insert into catalog_items (id, business_id, name, unit, unit_price_cents, job_type_id, kind, unit_cost_cents, taxable, sort_order)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, coalesce((select max(sort_order) + 1 from catalog_items where business_id = $2), 0))
     on conflict (id) do update set name = excluded.name, unit = excluded.unit, unit_price_cents = excluded.unit_price_cents,
       job_type_id = excluded.job_type_id, kind = excluded.kind, unit_cost_cents = excluded.unit_cost_cents, taxable = excluded.taxable, active = true
       where catalog_items.business_id = $2
     returning id`, [cid, businessId, name, unit, price, jt, kind, cost, taxable]);
  if (!rows.length) throw new HttpError(409, 'Already exists');
  return json({ config: await getConfig(businessId) });
}

async function deleteCatalogItem({ businessId }, id) {
  const rows = await query('update catalog_items set active = false where business_id = $1 and id = $2 returning id', [businessId, uuid(id, 'id')]);
  if (!rows.length) throw new HttpError(404, 'Not found');
  return json({ config: await getConfig(businessId) });
}

async function patchBusiness({ businessId }, req) {
  const b = await readJson(req);
  const fields = ['tax_rate_bps', 'license_no', 'quote_terms', 'min_charge_cents', 'uses_visits', 'default_deposit_pct', 'valid_days'];
  if (!fields.some((f) => has(b, f))) throw new HttpError(400, 'Nothing to change', { field: 'tax_rate_bps' });
  const int = (v, f, lo, hi, msg) => { if (!Number.isInteger(v) || v < lo || v > hi) throw new HttpError(400, msg, { field: f }); return v; };
  const sets = [], vals = [businessId];
  const add = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
  if (has(b, 'tax_rate_bps')) add('tax_rate_bps', int(b.tax_rate_bps, 'tax_rate_bps', 0, 2500, 'Tax rate must be between 0% and 25%.'));
  if (has(b, 'license_no')) add('license_no', str(b.license_no, 'license_no', { max: 60, optional: true }) || null);
  if (has(b, 'quote_terms')) add('quote_terms', str(b.quote_terms, 'quote_terms', { max: 2000, optional: true }) || null);
  if (has(b, 'min_charge_cents')) add('min_charge_cents', int(b.min_charge_cents, 'min_charge_cents', 0, 100_000_000, 'Minimum charge must be $0 or more.'));
  if (has(b, 'uses_visits')) { if (typeof b.uses_visits !== 'boolean') throw new HttpError(400, 'uses_visits must be true or false', { field: 'uses_visits' }); add('uses_visits', b.uses_visits); }
  if (has(b, 'default_deposit_pct')) add('default_deposit_pct', int(b.default_deposit_pct, 'default_deposit_pct', 0, 100, 'Deposit must be between 0% and 100%.'));
  if (has(b, 'valid_days')) add('valid_days', int(b.valid_days, 'valid_days', 1, 365, 'Quotes can be good for 1 to 365 days.'));
  await query(`update businesses set ${sets.join(', ')} where id = $1`, vals);
  return json({ config: await getConfig(businessId) });
}

async function exportRoute({ businessId }, url) {
  const format = (url.searchParams.get('format') || 'json').toLowerCase();
  if (format !== 'json' && format !== 'csv') throw new HttpError(400, 'format must be json or csv', { field: 'format' });
  const data = await loadExport(businessId);
  const name = `${data.business.slug}-export-${data.exported_at.slice(0, 10)}.${format}`;
  const headers = { 'content-disposition': `attachment; filename="${name}"`, 'cache-control': 'no-store' };
  return format === 'csv'
    ? new Response(toCsv(data), { status: 200, headers: { ...headers, 'content-type': 'text/csv; charset=utf-8' } })
    : new Response(JSON.stringify(data, null, 2), { status: 200, headers: { ...headers, 'content-type': 'application/json; charset=utf-8' } });
}

// ---- router -----------------------------------------------------------------------------

const ID = '([0-9a-fA-F-]{36})';
const ROUTES = [
  ['GET',   /^\/me$/,                            (s, m, url, req) => me(s)],
  ['GET',   /^\/export$/,                       (s, m, url) => exportRoute(s, url)],
  ['GET',   /^\/sync$/,                         (s, m, url) => syncPull(s, url)],
  ['POST',  /^\/clients$/,                       (s, m, url, req) => createClient(s, req)],
  ['GET',   new RegExp(`^/clients/${ID}$`),      (s, m) => getClientRoute(s, m[1])],
  ['PATCH', new RegExp(`^/clients/${ID}$`),      (s, m, url, req) => patchClient(s, m[1], req)],
  ['DELETE', new RegExp(`^/clients/${ID}$`),     (s, m) => deleteClient(s, m[1])],
  ['POST',  new RegExp(`^/clients/${ID}/jobs$`), (s, m, url, req) => addJob(s, m[1], req)],
  ['PATCH', new RegExp(`^/jobs/${ID}$`),         (s, m, url, req) => setStatus(s, m[1], req)],
  ['PUT',   new RegExp(`^/jobs/${ID}/quote$`),   (s, m, url, req) => putQuote(s, m[1], req)],
  ['PUT',   new RegExp(`^/catalog/${ID}$`),      (s, m, url, req) => putCatalogItem(s, m[1], req)],
  ['DELETE', new RegExp(`^/catalog/${ID}$`),     (s, m) => deleteCatalogItem(s, m[1])],
  ['PATCH', /^\/business$/,                      (s, m, url, req) => patchBusiness(s, req)],
  ['POST',  /^\/logout-all$/,                    (s, m, url, req) => logoutAll(req, s)],
  ['GET',   /^\/push\/key$/,                     () => pushKey()],
  ['GET',   /^\/push\/latest$/,                  (s) => pushLatest(s)],
  ['POST',  /^\/push\/subscribe$/,               (s, m, url, req) => pushSubscribe(s, req)],
  ['POST',  /^\/push\/unsubscribe$/,             (s, m, url, req) => pushUnsubscribe(s, req)],
];

export async function handle(req, context) {
  try {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/api/, '').replace(/\/+$/, '') || '/';
    const method = req.method.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') assertSameOrigin(req);

    if (path === '/login' && method === 'POST') return await login(req, clientIp(req, context));
    if (path === '/logout' && method === 'POST') return await logout(req);

    // Public install-invite endpoints (no session: the person hasn't signed in yet).
    const inv = path.match(/^\/invite\/([^/]+?)(\/consume)?$/);
    if (inv && method === 'GET' && !inv[2]) return await inviteGet(inv[1]);
    if (inv && method === 'POST' && inv[2]) { await readJson(req); return await inviteConsume(inv[1]); }
    const pq = path.match(/^\/q\/([^/]+?)(\/accept|\/decline)?$/);
    if (pq && method === 'GET' && !pq[2]) return await publicQuoteGet(pq[1]);
    if (pq && method === 'POST' && pq[2] === '/decline') return await publicQuoteDecline(pq[1], await readJson(req));
    if (pq && method === 'POST' && pq[2]) return await publicQuoteAccept(pq[1], await readJson(req), { ip: clientIp(req, context), ua: req.headers.get('user-agent') });
    if (path === '/manifest' && method === 'GET') return await inviteManifest(url.searchParams.get('i') || '');

    const matched = ROUTES.filter(([, re]) => re.test(path));
    if (!matched.length) throw new HttpError(404, 'Not found');
    const route = matched.find(([m]) => m === method);
    if (!route) throw new HttpError(405, 'Method not allowed');

    const session = await requireSession(req);
    const res = await route[2](session, path.match(route[1]), url, req);
    if (session.renewCookie && path !== '/logout-all') res.headers.append('set-cookie', session.renewCookie); // keeps a signed-in phone signed in
    return res;
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
