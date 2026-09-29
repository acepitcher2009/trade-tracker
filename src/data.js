// Local-first data layer.
//  - The phone keeps a full copy of the business's clients + jobs in IndexedDB. Lookups and the
//    client card read ONLY from it, so they are instant and work with no signal.
//  - Every change is written locally AND appended to a queue in one transaction. The sync engine
//    replays the queue to the server in order (all server writes are idempotent by client-made ids),
//    then pulls what changed on the server.
//  - Conflict policy: same phone number => one client (server's record wins, jobs are merged);
//    other edits are last-write-wins; a local pending edit is never overwritten by a pull.
import { openDB, deleteDB } from 'idb';
import { api as defaultApi, ApiError, newId } from './api.js';
import { normalizePhone } from '../shared/phone.js';
import { validateAddress, formatAddress } from '../shared/address.js';
import { validateQuote, totals } from '../shared/quote.js';

const CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const OVERLAP_MS = 30_000; // re-fetch a little history so slow commits are never missed
const iso = () => new Date().toISOString();

// The phone's own database. To change its shape later, add a step here: `if (oldVersion < 2) { ... }` and bump the
// version number below. Existing phones then upgrade in place, keeping their data and any unsent changes.
const DB_VERSION = 1;
function open(name) {
  return openDB(name, DB_VERSION, {
    upgrade(d, oldVersion) {
      if (oldVersion < 1) {
        d.createObjectStore('meta');
        const c = d.createObjectStore('clients', { keyPath: 'id' });
        c.createIndex('phone', 'phone_digits');
        c.createIndex('last4', 'last4');
        d.createObjectStore('jobs', { keyPath: 'id' }).createIndex('client', 'client_id');
        d.createObjectStore('queue', { keyPath: 'seq', autoIncrement: true });
      }
    },
  });
}

export async function readCachedConfig(slug, dbName = `tt-${slug}`) {
  const db = await open(dbName);
  try { return (await db.get('meta', 'config')) ?? null; } finally { db.close(); }
}
export const wipeDatabase = (slug, dbName = `tt-${slug}`) => deleteDB(dbName);

const clean = (v, max) => {
  if (v == null) return null;
  const s = String(v).replace(CTRL, '').trim();
  if (!s) return null;
  if (s.length > max) throw new Error(`That's too long (max ${max} characters).`);
  return s;
};
const newest = (a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : a.id < b.id ? 1 : -1);
const normClient = (c) => ({
  id: c.id, name: c.name, phone_digits: c.phone_digits, last4: c.phone_digits.slice(-4),
  address_line: c.address_line ?? null, city: c.city ?? null, state: c.state ?? null, zip: c.zip ?? null,
  address: c.address ?? null, address_complete: !!c.address_line, // one-line display text, and whether the full address is on file
  notes: c.notes ?? null, created_at: c.created_at, updated_at: c.updated_at,
});
const normJob = (j) => ({
  id: j.id, client_id: j.client_id, job_type_id: j.job_type_id, status_id: j.status_id,
  notes: j.notes ?? null, created_at: j.created_at, updated_at: j.updated_at,
  scheduled_date: j.scheduled_date ?? null, scheduled_time: j.scheduled_time ?? null,
  quote: j.quote ?? null, quote_accepted_at: j.quote_accepted_at ?? null, quote_accepted_by: j.quote_accepted_by ?? null,
  quote_selection: j.quote_selection ?? null, quote_accepted_total_cents: j.quote_accepted_total_cents ?? null,
  parent_job_id: j.parent_job_id ?? null, duration_days: j.duration_days ?? 1, assigned_to: j.assigned_to ?? null, recurrence: j.recurrence ?? null,
  declined_at: j.declined_at ?? null, decline_reason: j.decline_reason ?? null, payments: Array.isArray(j.payments) ? j.payments : [],
});
const EVERY_LABEL = { week: 'every week', '2weeks': 'every 2 weeks', month: 'every month', quarter: 'every 3 months', year: 'every year' };
export { EVERY_LABEL };
/** 'YYYY-MM-DD' plus n days / months (calendar math in UTC so it never shifts with time zones). */
export function addDays(date, n) { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
export function nextOccurrence(date, every) {
  if (every === 'week') return addDays(date, 7);
  if (every === '2weeks') return addDays(date, 14);
  const [y, m, d] = date.split('-').map(Number);
  const add = every === 'month' ? 1 : every === 'quarter' ? 3 : 12;
  const t = new Date(Date.UTC(y, m - 1 + add, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(d, last));
  return t.toISOString().slice(0, 10);
}
const CLEAR_DATE = new Set(['new', 'quoted', 'accepted']);
const DONE_KEYS = new Set(['done', 'paid']);
const isTransient = (e) => !(e instanceof ApiError) || [0, 401, 403, 408, 429].includes(e.status) || e.status >= 500;

/**
 * `demo: true` is the guided tour's sample copy: it lives in its own database, never talks to the server, and forgets its
 * unsent-changes queue as it goes, so nothing done in the tour can reach the real list.
 */
export function createData(slug, { api = defaultApi, dbName = `tt-${slug}`, autoSync = true, demo = false } = {}) {
  let db, config = null, typeName = new Map(), statusById = new Map();
  let running = null, rerun = false, timer = null, stopFns = [];
  const aliases = new Map(); // local client id -> server client id after a same-phone merge
  const state = { reachable: true, syncing: false, pending: 0, failed: 0, failedOps: [], lastSyncAt: null, ready: false, authExpired: false, error: '' };
  let version = 0, snap = { ...state, version };
  const listeners = new Set();
  const emit = () => { snap = { ...state, version: ++version }; listeners.forEach((l) => l()); };

  const setConfig = (cfg) => {
    config = { business: cfg.business, job_types: cfg.job_types, job_types_all: cfg.job_types_all ?? cfg.job_types, statuses: cfg.statuses, catalog: cfg.catalog ?? [] };
    typeName = new Map(config.job_types_all.map((t) => [t.id, t.name]));
    statusById = new Map(config.statuses.map((s) => [s.id, s]));
  };
  const hydrateJob = (j) => {
    const s = statusById.get(j.status_id);
    const total = j.quote ? totals(j.quote, j.quote_selection).total : null;
    const payments = Array.isArray(j.payments) ? j.payments : []; // jobs saved on this phone by an older version have no list yet
    const paid = payments.reduce((n, p) => n + p.amount_cents, 0);
    // No job type yet means it is still an estimate: the type is picked in the quote form.
    return { ...j, payments, declined_at: j.declined_at ?? null, decline_reason: j.decline_reason ?? null, quote_total_cents: total, paid_cents: paid, balance_cents: total != null ? Math.max(0, total - paid) : null,
      job_type: j.job_type_id ? (typeName.get(j.job_type_id) ?? 'Job') : 'Estimate', status_key: s?.key, status_label: s?.label ?? '?', status_color: s?.color };
  };

  const describe = (op) => ({
    createClient: `Add ${op.payload?.name ?? 'client'}`, addJob: 'Add job', patchJob: 'Edit job details', setStatus: 'Change job status', patchClient: 'Edit client details', deleteClient: 'Delete client', deleteJob: 'Delete quote', setQuote: 'Save quote',
  }[op.type] ?? op.type);

  async function refreshCounts() {
    const ops = await db.getAll('queue');
    state.pending = ops.filter((o) => !o.failed).length;
    const failed = ops.filter((o) => o.failed);
    state.failed = failed.length;
    state.failedOps = failed.map((o) => ({ seq: o.seq, label: describe(o), error: o.error }));
  }
  async function pendingSets() {
    const out = { clients: new Set(), jobs: new Set(), creates: new Set() };
    for (const o of await db.getAll('queue')) {
      if (o.type === 'createClient') { out.clients.add(o.payload.id); out.creates.add(o.payload.id); if (o.payload.job) out.jobs.add(o.payload.job.id); }
      if (o.type === 'patchClient') out.clients.add(o.clientId);
      if (o.type === 'addJob') out.jobs.add(o.body.id);
      if (o.type === 'setStatus' || o.type === 'setQuote' || o.type === 'patchJob' || o.type === 'deleteJob') out.jobs.add(o.jobId);
    }
    return out;
  }
  async function changed() {
    if (demo) await db.clear('queue');
    await refreshCounts(); emit();
    if (autoSync) { clearTimeout(timer); timer = setTimeout(() => sync(), 300); }
  }

  // ---------------- reads (local only) ----------------
  // Everything the home board and the search box need, built from the local copy only.
  async function summarize(c, pend) {
    const jobs = (await db.getAllFromIndex('jobs', 'client', c.id)).sort(newest);
    const last = jobs[0] ? hydrateJob(jobs[0]) : null;
    const existing = jobs.some((j) => DONE_KEYS.has(statusById.get(j.status_id)?.key));
    // The soonest booked visit or job, so the client list can show "Job · Thu, Oct 1 · 8:00 AM".
    const booked = jobs.filter((j) => j.scheduled_date && ['visit', 'scheduled'].includes(statusById.get(j.status_id)?.key))
      .sort((x, y) => (x.scheduled_date + (x.scheduled_time || '')).localeCompare(y.scheduled_date + (y.scheduled_time || '')))[0];
    return {
      existing,
      booked_kind: booked ? statusById.get(booked.status_id).key : null, booked_date: booked?.scheduled_date ?? null, booked_time: booked?.scheduled_time ?? null,
      id: c.id, name: c.name, phone_digits: c.phone_digits, address: c.address, address_complete: !!c.address_line, notes: c.notes, job_count: jobs.length,
      last_job_at: last?.created_at ?? null, last_job_type: last?.job_type ?? null,
      last_job_status: last?.status_label ?? null, last_job_color: last?.status_color ?? null,
      pending: pend.clients.has(c.id) || jobs.some((j) => pend.jobs.has(j.id)),
    };
  }

  /** Every job with its client attached, newest activity first (the board groups them by status). */
  async function board() {
    const pend = await pendingSets();
    const clients = new Map((await db.getAll('clients')).map((c) => [c.id, c]));
    const allJobs = await db.getAll('jobs');
    const served = new Set(allJobs.filter((j) => DONE_KEYS.has(statusById.get(j.status_id)?.key)).map((j) => j.client_id));
    const out = [];
    for (const j of allJobs) {
      const c = clients.get(j.client_id);
      if (!c) continue;
      out.push({ ...hydrateJob(j), client_existing: served.has(c.id), client_name: c.name, client_phone: c.phone_digits, client_address: c.address, client_address_complete: !!c.address_line, pending: pend.jobs.has(j.id) || pend.clients.has(c.id) });
    }
    out.sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0));
    return out;
  }

  const clientCount = () => db.count('clients');

  /** News for the top of the board: customers who accepted (and are waiting for a job date) or declined a quote since this phone last dismissed it. */
  async function acceptances() {
    const seen = (await db.get('meta', 'seenAccepted')) ?? '';
    const clients = new Map((await db.getAll('clients')).map((c) => [c.id, c]));
    const out = [];
    for (const j of await db.getAll('jobs')) {
      const c = clients.get(j.client_id);
      if (!c) continue;
      const key = statusById.get(j.status_id)?.key;
      const base = { job_id: j.id, client_id: c.id, client_name: c.name, phone_digits: c.phone_digits,
        total_cents: j.quote ? totals(j.quote, j.quote_selection).total : null, job_type: j.job_type_id ? (typeName.get(j.job_type_id) ?? 'Job') : 'Estimate' };
      if (key === 'accepted' && j.quote_accepted_at && j.quote_accepted_at > seen) out.push({ ...base, name: j.quote_accepted_by || c.name, at: j.quote_accepted_at });
      else if (key === 'quoted' && j.declined_at && j.declined_at > seen) out.push({ ...base, name: c.name, declined: true, reason: j.decline_reason, at: j.declined_at });
    }
    return out.sort((a, b) => (a.at < b.at ? 1 : -1));
  }
  async function dismissAcceptances() {
    const all = await acceptances();
    const latest = all.reduce((m, a) => (a.at > m ? a.at : m), (await db.get('meta', 'seenAccepted')) ?? '');
    await db.put('meta', latest, 'seenAccepted');
    emit();
  }

  /** Every job currently booked on a date, for the calendar (so nobody double-books). */
  async function bookings() {
    const clients = new Map((await db.getAll('clients')).map((c) => [c.id, c]));
    const out = [];
    for (const j of await db.getAll('jobs')) {
      const h = hydrateJob(j);
      if (!['visit', 'scheduled'].includes(h.status_key) || !j.scheduled_date) continue;
      const days = h.status_key === 'scheduled' ? (j.duration_days ?? 1) : 1;
      for (let d = 0; d < days; d++) {
        out.push({ id: j.id, crew: j.assigned_to ?? null, date: d ? addDays(j.scheduled_date, d) : j.scheduled_date, time: j.scheduled_time, name: clients.get(j.client_id)?.name ?? 'Client',
          type: (h.status_key === 'visit' ? `Site visit · ${h.job_type}` : h.job_type) + (days > 1 ? ` · day ${d + 1} of ${days}` : '') + (j.assigned_to ? ` · ${j.assigned_to}` : '') });
      }
    }
    return out;
  }

  /** Search clients by any part of name, address or phone (3+ digits, incl. last 4). Empty q = everyone. */
  async function search(q = '') {
    const text = String(q).trim().toLowerCase();
    let digits = text.replace(/\D/g, '');
    if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1); // "+1 979 555 1234" pasted from a call log
    const pend = await pendingSets();
    const out = [];
    for (const c of await db.getAll('clients')) {
      const hit = !text
        || `${c.name} ${c.address ?? ''}`.toLowerCase().includes(text)
        || (digits.length >= 3 && c.phone_digits.includes(digits));
      if (hit) out.push(await summarize(c, pend));
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  async function getCard(id) {
    const rid = aliases.get(id) ?? id;
    const c = await db.get('clients', rid);
    if (!c) return null;
    const pend = await pendingSets();
    const jobs = (await db.getAllFromIndex('jobs', 'client', rid)).sort(newest).map(hydrateJob);
    return { ...c, jobs, existing: jobs.some((j) => DONE_KEYS.has(j.status_key)), pending: pend.clients.has(rid) || jobs.some((j) => pend.jobs.has(j.id)) };
  }

  // ---------------- writes (local + queue, atomically) ----------------
  // A job created with a date is a booked site visit ("Quote Scheduled"); without one it is just New.
  function newJobFields(schedule) {
    if (!schedule) return { status_id: config.statuses[0].id };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(schedule.date || '')) throw new Error('Pick a valid date.');
    if (!/^([01]\d|2[0-3]):(00|30)$/.test(schedule.time || '')) throw new Error('Pick a time on the hour or half hour.');
    const visit = config.statuses.find((x) => x.key === 'visit');
    return { status_id: (visit ?? config.statuses[0]).id, scheduled_date: schedule.date, scheduled_time: schedule.time };
  }
  function checkJobType(id) {
    if (id && !config.job_types.some((t) => t.id === id)) throw new Error('Pick a job type.');
  }

  async function addJob(clientId, { jobTypeId, notes, schedule, parentJobId, durationDays, assignedTo, recurrence, statusKey } = {}) {
    checkJobType(jobTypeId);
    const cid = aliases.get(clientId) ?? clientId;
    const now = iso();
    const extra = { ...(parentJobId ? { parent_job_id: parentJobId } : {}), ...(durationDays > 1 ? { duration_days: durationDays } : {}),
      ...(assignedTo ? { assigned_to: assignedTo } : {}), ...(recurrence ? { recurrence } : {}) };
    const fields = newJobFields(schedule);
    const sk = statusKey && config.statuses.find((x) => x.key === statusKey);
    if (sk) fields.status_id = sk.id;
    const job = normJob({ id: newId(), client_id: cid, job_type_id: jobTypeId ?? null, ...fields, ...extra, notes: clean(notes, 4000), created_at: now, updated_at: now });
    const tx = db.transaction(['jobs', 'queue', 'clients'], 'readwrite');
    if (!(await tx.objectStore('clients').get(cid))) throw new Error('Client not found.');
    tx.objectStore('jobs').put(job);
    tx.objectStore('queue').add({ type: 'addJob', clientId: cid, body: { id: job.id, ...(job.job_type_id ? { job_type_id: job.job_type_id } : {}), status_id: job.status_id, ...(job.scheduled_date ? { scheduled_date: job.scheduled_date, scheduled_time: job.scheduled_time } : {}), ...(job.notes ? { notes: job.notes } : {}), ...extra }, createdAt: now });
    await tx.done;
    await changed();
    return hydrateJob(job);
  }

  async function createClient({ name, phone, addressLine, city, state, zip, notes, jobTypeId, schedule }) {
    const nm = clean(name, 120);
    if (!nm) throw new Error('Enter a name.');
    const digits = normalizePhone(phone);
    if (!digits) throw new Error('Enter a valid 10-digit phone number.');
    const av = validateAddress({ line: addressLine, city, state, zip });
    if (!av.ok) throw new Error(av.error);
    const a = av.value, nts = clean(notes, 4000);
    if (jobTypeId) checkJobType(jobTypeId);

    const existing = (await db.getAllFromIndex('clients', 'phone', digits))[0];
    if (existing) { // same number never makes a second client
      await addJob(existing.id, { jobTypeId, schedule });
      return { created: false, client: await getCard(existing.id) };
    }
    const now = iso(), id = newId();
    const client = { id, name: nm, phone_digits: digits, last4: digits.slice(-4),
      address_line: a.line, city: a.city, state: a.state, zip: a.zip, address: formatAddress(a), address_complete: true, notes: nts, created_at: now, updated_at: now };
    const job = normJob({ id: newId(), client_id: id, job_type_id: jobTypeId ?? null, ...newJobFields(schedule), notes: null, created_at: now, updated_at: now });
    const tx = db.transaction(['clients', 'jobs', 'queue'], 'readwrite');
    tx.objectStore('clients').put(client);
    tx.objectStore('jobs').put(job);
    tx.objectStore('queue').add({
      type: 'createClient', createdAt: now,
      payload: { id, name: nm, phone: digits, address_line: a.line, city: a.city, state: a.state, zip: a.zip, ...(nts ? { notes: nts } : {}),
        job: { id: job.id, ...(job.job_type_id ? { job_type_id: job.job_type_id } : {}), status_id: job.status_id, ...(job.scheduled_date ? { scheduled_date: job.scheduled_date, scheduled_time: job.scheduled_time } : {}) } },
    });
    await tx.done;
    await changed();
    return { created: true, client: await getCard(id) };
  }

  // Change a job's status and/or schedule. `schedule` = { date: 'YYYY-MM-DD'|null, time: 'HH:MM'|null };
  // leave it undefined to keep the current schedule. Only the latest change per job is queued.
  async function setStatus(jobId, statusId, schedule) {
    if (!statusById.has(statusId)) throw new Error('Unknown status.');
    if (schedule?.date && !/^\d{4}-\d{2}-\d{2}$/.test(schedule.date)) throw new Error('Pick a valid date.');
    if (schedule?.date && !schedule.time) throw new Error('Pick a time.');
    if (schedule?.time && !/^([01]\d|2[0-3]):(00|30)$/.test(schedule.time)) throw new Error('Pick a time on the hour or half hour.');
    const tx = db.transaction(['jobs', 'queue'], 'readwrite');
    const job = await tx.objectStore('jobs').get(jobId);
    if (!job) throw new Error('Job not found.');
    // A date belongs to the Visit and Scheduled stages; moving to New/Quoted/Accepted drops the old one.
    const dropDate = !schedule && CLEAR_DATE.has(statusById.get(statusId)?.key) && !!job.scheduled_date;
    if (dropDate) schedule = { date: null, time: null };
    const sched = schedule ? { date: schedule.date || null, time: schedule.date ? (schedule.time || null) : null } : undefined;
    tx.objectStore('jobs').put({
      ...job, status_id: statusId, updated_at: iso(),
      ...(sched ? { scheduled_date: sched.date, scheduled_time: sched.time } : {}),
    });
    let carried = sched;
    for (const o of await tx.objectStore('queue').getAll()) { // only the latest tap per job needs to be sent
      if (o.type === 'setStatus' && o.jobId === jobId && !o.failed) {
        carried = carried ?? o.schedule; // an earlier unsent schedule must not be lost
        tx.objectStore('queue').delete(o.seq);
      }
    }
    tx.objectStore('queue').add({ type: 'setStatus', jobId, statusId, ...(carried ? { schedule: carried } : {}), createdAt: iso() });
    await tx.done;
    // A repeating job that is finished books its own next visit (the repeat moves to the new job).
    if (statusById.get(statusId)?.key === 'done' && job.recurrence?.every && job.scheduled_date && statusById.get(job.status_id)?.key !== 'done') {
      const scheduledId = config.statuses.find((x) => x.key === 'scheduled')?.id;
      const next = await addJob(job.client_id, { jobTypeId: job.job_type_id, notes: job.notes, assignedTo: job.assigned_to, durationDays: job.duration_days,
        recurrence: job.recurrence, statusKey: 'scheduled', schedule: undefined });
      if (scheduledId) await setStatus(next.id, scheduledId, { date: nextOccurrence(job.scheduled_date, job.recurrence.every), time: job.scheduled_time });
      await patchJob(jobId, { recurrence: null });
      return;
    }
    await changed();
  }

  const PAY_METHODS = ['cash', 'check', 'card', 'transfer', 'other'];
  function checkPayments(list) {
    if (!Array.isArray(list)) throw new Error('Payments must be a list.');
    return list.map((p) => {
      const amount = Math.round(Number(p.amount_cents));
      if (!Number.isInteger(amount) || amount < 1) throw new Error('Enter an amount of at least $0.01.');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date || '')) throw new Error('Pick the date the payment came in.');
      const note = clean(p.note, 200);
      return { id: p.id || newId(), amount_cents: amount, method: PAY_METHODS.includes(p.method) ? p.method : 'other', date: p.date, ...(note ? { note } : {}) };
    });
  }

  /** Edit a job's practical details (days it takes, who does it, how often it repeats). */
  async function patchJob(jobId, fields) {
    const f = {};
    if ('duration_days' in fields) {
      const n = Number(fields.duration_days);
      if (!Number.isInteger(n) || n < 1 || n > 60) throw new Error('Days must be between 1 and 60.');
      f.duration_days = n;
    }
    if ('assigned_to' in fields) f.assigned_to = clean(fields.assigned_to, 60);
    if ('notes' in fields) f.notes = clean(fields.notes, 4000);
    if ('payments' in fields) f.payments = checkPayments(fields.payments);
    if ('recurrence' in fields) {
      if (fields.recurrence && !EVERY_LABEL[fields.recurrence.every]) throw new Error('Pick how often the job repeats.');
      f.recurrence = fields.recurrence ? { every: fields.recurrence.every } : null;
    }
    const tx = db.transaction(['jobs', 'queue'], 'readwrite');
    const job = await tx.objectStore('jobs').get(jobId);
    if (!job) throw new Error('Job not found.');
    tx.objectStore('jobs').put({ ...job, ...f, updated_at: iso() });
    let merged = f;
    for (const o of await tx.objectStore('queue').getAll()) {
      if (o.type === 'patchJob' && o.jobId === jobId && !o.failed) { merged = { ...o.fields, ...f }; tx.objectStore('queue').delete(o.seq); }
    }
    tx.objectStore('queue').add({ type: 'patchJob', jobId, fields: merged, createdAt: iso() });
    await tx.done;
    await changed();
  }

  /** Set or clear just the date/time, keeping the job's current status. */
  async function setSchedule(jobId, schedule) {
    const job = await db.get('jobs', jobId);
    if (!job) throw new Error('Job not found.');
    return setStatus(jobId, job.status_id, schedule);
  }

  const stable = (q) => JSON.stringify({ ...q, sent_at: undefined });

  /** Save the job's itemized quote (null removes it). Works offline like every other change. */
  async function setQuote(jobId, quote, jobTypeId) {
    let value = null;
    if (jobTypeId) checkJobType(jobTypeId);
    if (quote !== null) {
      const r = validateQuote(quote);
      if (!r.ok) throw new Error(r.error);
      value = r.value;
    }
    const tx = db.transaction(['jobs', 'queue'], 'readwrite');
    const job = await tx.objectStore('jobs').get(jobId);
    if (!job) throw new Error('Job not found.');
    if (value && !jobTypeId && !job.job_type_id) throw new Error('Pick what kind of job this is.');
    // Same rule as the server: changing the numbers (not just marking it sent) clears an earlier acceptance.
    let carriedType = jobTypeId;
    const differs = !value || !job.quote || stable(job.quote) !== stable(value);
    tx.objectStore('jobs').put({ ...job, quote: value, updated_at: iso(), ...(jobTypeId ? { job_type_id: jobTypeId } : {}),
      ...(differs ? { quote_accepted_at: null, quote_accepted_by: null, quote_selection: null, quote_accepted_total_cents: null, declined_at: null, decline_reason: null } : {}) });
    for (const o of await tx.objectStore('queue').getAll()) {
      if (o.type === 'setQuote' && o.jobId === jobId && !o.failed) { carriedType = carriedType ?? o.jobTypeId; tx.objectStore('queue').delete(o.seq); }
    }
    tx.objectStore('queue').add({ type: 'setQuote', jobId, quote: value, ...(carriedType ? { jobTypeId: carriedType } : {}), createdAt: iso() });
    await tx.done;
    // Sending the quote is what makes a job "Quoted"; until then it stays New.
    const quotedId = config.statuses.find((s) => s.key === 'quoted')?.id;
    if (value?.sent_at && quotedId && ['new', 'visit'].includes(statusById.get(job.status_id)?.key)) { await setStatus(jobId, quotedId); return; }
    await changed();
  }

  // Price list + tax rate: owner setup, needs a connection (the server answers with the fresh config).
  async function adopt(r) { setConfig(r.config); await db.put('meta', r.config, 'config'); emit(); }
  const saveCatalogItem = async (item) => adopt(await api.putCatalogItem(item.id ?? newId(), {
    name: item.name, unit: item.unit, unit_price_cents: item.unit_price_cents, job_type_id: item.job_type_id ?? null,
    kind: item.kind ?? 'item', unit_cost_cents: item.unit_cost_cents ?? null, taxable: item.taxable !== false }));
  const deleteCatalogItem = async (id) => adopt(await api.deleteCatalogItem(id));
  const setTaxRate = async (bps) => adopt(await api.patchBusiness({ tax_rate_bps: bps }));
  const saveBusiness = async (fields) => adopt(await api.patchBusiness(fields));

  async function patchClient(id, fields) {
    const cid = aliases.get(id) ?? id;
    const patch = {};
    if ('name' in fields) { patch.name = clean(fields.name, 120); if (!patch.name) throw new Error('Name can’t be empty.'); }
    if (['addressLine', 'city', 'state', 'zip'].some((k) => k in fields)) { // the four parts are saved together
      const av = validateAddress({ line: fields.addressLine, city: fields.city, state: fields.state, zip: fields.zip });
      if (!av.ok) throw new Error(av.error);
      Object.assign(patch, { address_line: av.value.line, city: av.value.city, state: av.value.state, zip: av.value.zip });
    }
    if ('notes' in fields) patch.notes = clean(fields.notes, 4000);
    if (!Object.keys(patch).length) return;
    const tx = db.transaction(['clients', 'queue'], 'readwrite');
    const c = await tx.objectStore('clients').get(cid);
    if (!c) throw new Error('Client not found.');
    const next = { ...c, ...patch, updated_at: iso() };
    if (patch.address_line) { next.address = formatAddress({ line: next.address_line, city: next.city, state: next.state, zip: next.zip }); next.address_complete = true; }
    tx.objectStore('clients').put(next);
    let merged = patch;
    for (const o of await tx.objectStore('queue').getAll()) {
      if (o.type === 'patchClient' && o.clientId === cid && !o.failed) { merged = { ...o.fields, ...patch }; tx.objectStore('queue').delete(o.seq); }
    }
    tx.objectStore('queue').add({ type: 'patchClient', clientId: cid, fields: merged, createdAt: iso() });
    await tx.done;
    await changed();
  }

  /** Remove a client and their jobs from this device, and tell the server (queued if offline). */
  async function deleteClient(id) {
    const cid = aliases.get(id) ?? id;
    const tx = db.transaction(['clients', 'jobs', 'queue'], 'readwrite');
    const c = await tx.objectStore('clients').get(cid);
    if (!c) throw new Error('Client not found.');
    const jobIds = new Set((await tx.objectStore('jobs').index('client').getAll(cid)).map((j) => j.id));
    let neverSynced = false;
    for (const o of await tx.objectStore('queue').getAll()) {
      const mine = o.clientId === cid || o.payload?.id === cid || (o.type === 'addJob' && o.body?.client_id === cid) || jobIds.has(o.jobId);
      if (!mine) continue;
      if (o.type === 'createClient') neverSynced = true;
      tx.objectStore('queue').delete(o.seq); // edits to a client that is going away are moot
    }
    for (const jid of jobIds) tx.objectStore('jobs').delete(jid);
    tx.objectStore('clients').delete(cid);
    if (!neverSynced) tx.objectStore('queue').add({ type: 'deleteClient', clientId: cid, createdAt: iso() });
    await tx.done;
    await changed();
  }

  /** Delete one job (a quote nobody answered) from this device and tell the server. The customer stays. */
  async function deleteJob(jobId) {
    const tx = db.transaction(['jobs', 'queue'], 'readwrite');
    const job = await tx.objectStore('jobs').get(jobId);
    if (!job) throw new Error('Job not found.');
    let neverSynced = false;
    for (const o of await tx.objectStore('queue').getAll()) {
      if (o.type === 'addJob' && o.body?.id === jobId) { neverSynced = true; tx.objectStore('queue').delete(o.seq); }
      else if (o.type === 'createClient' && o.payload?.job?.id === jobId) { neverSynced = true; const { job: _gone, ...payload } = o.payload; tx.objectStore('queue').put({ ...o, payload }); }
      else if (o.jobId === jobId) tx.objectStore('queue').delete(o.seq); // edits to a job that is going away are moot
    }
    tx.objectStore('jobs').delete(jobId);
    if (!neverSynced) tx.objectStore('queue').add({ type: 'deleteJob', jobId, createdAt: iso() });
    await tx.done;
    await changed();
  }

  /** Record money received on a job (a deposit or the final payment). Moves a finished job to Paid once it is covered. */
  async function addPayment(jobId, { amountCents, method, date, note }) {
    const job = await db.get('jobs', jobId);
    if (!job) throw new Error('Job not found.');
    const list = [...(job.payments ?? []), { id: newId(), amount_cents: amountCents, method, date, note }];
    await patchJob(jobId, { payments: list });
    const h = hydrateJob({ ...job, payments: checkPayments(list) });
    const paidId = config.statuses.find((x) => x.key === 'paid')?.id;
    if (h.status_key === 'done' && paidId && h.balance_cents === 0 && h.quote_total_cents != null) await setStatus(jobId, paidId);
  }
  async function removePayment(jobId, paymentId) {
    const job = await db.get('jobs', jobId);
    if (!job) throw new Error('Job not found.');
    await patchJob(jobId, { payments: (job.payments ?? []).filter((p) => p.id !== paymentId) });
  }

  /** Tour only: set fields on a sample job directly (for example, "the customer already accepted"). */
  async function demoUpdateJob(jobId, fields) {
    if (!demo) throw new Error('Only the tour can do that.');
    const job = await db.get('jobs', jobId);
    if (!job) throw new Error('Job not found.');
    await db.put('jobs', { ...job, ...fields, updated_at: iso() });
    await changed();
  }

  // ---------------- sync ----------------
  async function remap(oldId, sc) {
    const tx = db.transaction(['clients', 'jobs', 'queue'], 'readwrite');
    const jobs = tx.objectStore('jobs');
    for (const j of await jobs.index('client').getAll(oldId)) jobs.put({ ...j, client_id: sc.id });
    tx.objectStore('clients').delete(oldId);
    tx.objectStore('clients').put(normClient(sc));
    for (const j of sc.jobs ?? []) if (!(await jobs.get(j.id))) jobs.put(normJob(j));
    for (const o of await tx.objectStore('queue').getAll()) if (o.clientId === oldId) tx.objectStore('queue').put({ ...o, clientId: sc.id });
    await tx.done;
    aliases.set(oldId, sc.id);
  }

  async function sendOp(op) {
    switch (op.type) {
      case 'createClient': {
        const r = await api.createClient(op.payload);
        if (r.client.id !== op.payload.id) await remap(op.payload.id, r.client);
        break;
      }
      case 'addJob': await api.addJob(op.clientId, op.body); break;
      case 'setStatus': await api.setStatus(op.jobId, op.statusId, op.schedule); break;
      case 'setQuote': await api.putQuote(op.jobId, op.quote, op.jobTypeId); break;
      case 'deleteJob': await api.patchJob(op.jobId, { deleted: true }); break;
      case 'patchJob': await api.patchJob(op.jobId, op.fields); break;
      case 'deleteClient': await api.deleteClient(op.clientId); break;
      case 'patchClient': await api.patchClient(op.clientId, op.fields); break;
      default: throw new ApiError(400, `Unknown change type ${op.type}`);
    }
  }

  // A change the server refuses can leave later changes with nothing to stand on (a status change for a job that was
  // never created, a job for a client that was never added). Those are set aside with it instead of failing confusingly
  // later. Unrelated changes keep going.
  const creates = (o) => (o.type === 'createClient' ? [o.payload?.id, o.payload?.job?.id] : o.type === 'addJob' ? [o.body?.id] : []).filter(Boolean);
  const needs = (o) => [o.clientId, o.jobId].filter(Boolean);

  async function push() {
    const blocked = new Set();
    for (;;) {
      const op = (await db.getAll('queue')).filter((o) => !o.failed).sort((a, b) => a.seq - b.seq)[0];
      if (!op) return;
      if (needs(op).some((k) => blocked.has(k))) {
        await db.put('queue', { ...op, failed: true, error: 'Waiting on an earlier change that could not be saved. Fix or discard that one first.' });
        for (const k of creates(op)) blocked.add(k);
        await refreshCounts(); emit();
        continue;
      }
      try {
        await sendOp(op);
        await db.delete('queue', op.seq);
      } catch (e) {
        if (isTransient(e)) throw e; // keep the queue intact, order preserved, try again later
        await db.put('queue', { ...op, failed: true, error: e.message }); // server said no: park it
        for (const k of creates(op)) blocked.add(k);
      }
      await refreshCounts(); emit();
    }
  }

  async function applyPull(r, pend) {
    const skippedClients = new Set();
    const tx = db.transaction(['clients', 'jobs'], 'readwrite');
    const clients = tx.objectStore('clients'), jobs = tx.objectStore('jobs');
    for (const c of r.clients) {
      if (pend.clients.has(c.id)) continue; // local unsynced edit wins until it is pushed
      const twin = (await clients.index('phone').getAll(c.phone_digits)).find((x) => x.id !== c.id);
      if (twin && pend.creates.has(twin.id)) { skippedClients.add(c.id); continue; } // will be merged when the queue drains
      clients.put(normClient(c));
    }
    for (const j of r.jobs) {
      if (pend.jobs.has(j.id) || skippedClients.has(j.client_id)) continue;
      if (j.deleted_at) { jobs.delete(j.id); continue; } // deleted on another device
      jobs.put(normJob(j));
    }
    for (const cid of r.deleted_client_ids ?? []) { // deleted on another device
      if (pend.creates.has(cid)) continue;
      for (const j of await jobs.index('client').getAll(cid)) jobs.delete(j.id);
      clients.delete(cid);
    }
    await tx.done;
  }

  const CONFIG_EVERY_MS = 10 * 60_000; // settings rarely change; re-download them every 10 minutes (or right away when we have none)
  const FULL_AFTER_MS = 45 * 24 * 3600_000; // away this long: start over (the server forgets deletions after 90 days)

  async function pull(full) {
    let since = full ? null : (await db.get('meta', 'since')) ?? null;
    if (since && Date.now() - Date.parse(since) > FULL_AFTER_MS) since = null;
    const seen = new Set(), seenJobs = new Set();
    let everything = false;
    for (let page = 0; page < 200; page++) {
      const needConfig = !config || since === null || Date.now() - Date.parse((await db.get('meta', 'configAt')) ?? 0) > CONFIG_EVERY_MS;
      const r = await api.sync(since, { config: needConfig });
      if (page === 0) everything = !!r.full;
      if (r.config) { setConfig(r.config); await db.put('meta', r.config, 'config'); await db.put('meta', iso(), 'configAt'); }
      for (const c of r.clients) seen.add(c.id);
      for (const j of r.jobs) seenJobs.add(j.id);
      await applyPull(r, await pendingSets());
      if (!r.more) {
        if (everything) await purgeMissing(seen, seenJobs); // a full download lists every client: anything else here was deleted elsewhere
        await db.put('meta', new Date(Date.parse(r.server_time) - OVERLAP_MS).toISOString(), 'since');
        state.lastSyncAt = iso(); await db.put('meta', state.lastSyncAt, 'lastSync');
        state.ready = true;
        return;
      }
      if (!r.next_since || r.next_since === since) throw new ApiError(500, 'Sync could not page forward');
      since = r.next_since;
    }
  }

  /** After a full download: drop local clients (and their jobs) the server no longer has, unless they are unsent local work. */
  async function purgeMissing(seen, seenJobs = new Set()) {
    const pend = await pendingSets();
    const tx = db.transaction(['clients', 'jobs'], 'readwrite');
    for (const c of await tx.objectStore('clients').getAll()) {
      if (seen.has(c.id) || pend.creates.has(c.id) || pend.clients.has(c.id)) continue;
      for (const j of await tx.objectStore('jobs').index('client').getAll(c.id)) tx.objectStore('jobs').delete(j.id);
      tx.objectStore('clients').delete(c.id);
    }
    for (const j of await tx.objectStore('jobs').getAll()) { // a job removed on another phone while this one was away
      if (!seenJobs.has(j.id) && !pend.jobs.has(j.id) && !pend.creates.has(j.client_id) && seen.has(j.client_id)) tx.objectStore('jobs').delete(j.id);
    }
    await tx.done;
  }

  function sync({ full = false } = {}) {
    if (demo) return (async () => { await db.clear('queue'); await refreshCounts(); emit(); })();
    if (running) { rerun = true; return running; }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) { state.reachable = false; emit(); return Promise.resolve(); }
    state.syncing = true; emit();
    running = (async () => {
      try {
        await push();
        await pull(full || !!(await db.get('meta', 'needFull')));
        await db.delete('meta', 'needFull');
        state.reachable = true; state.authExpired = false; state.error = '';
      } catch (e) {
        if (e instanceof ApiError && e.status === 0) state.reachable = false;
        else if (e instanceof ApiError && e.status === 401) { state.reachable = true; state.authExpired = true; }
        else { state.reachable = true; state.error = e.message || 'Sync problem'; }
      } finally {
        state.syncing = false; running = null;
        await refreshCounts(); emit();
        if (rerun) { rerun = false; sync(); }
      }
    })();
    return running;
  }

  async function discard(seq) {
    const op = await db.get('queue', seq);
    if (!op) return;
    if (op.type === 'createClient') { // never reached the server: remove the local copy too
      const tx = db.transaction(['clients', 'jobs', 'queue'], 'readwrite');
      for (const j of await tx.objectStore('jobs').index('client').getAll(op.payload.id)) tx.objectStore('jobs').delete(j.id);
      tx.objectStore('clients').delete(op.payload.id);
      tx.objectStore('queue').delete(seq);
      await tx.done;
    } else {
      const tx = db.transaction(['jobs', 'queue'], 'readwrite');
      if (op.type === 'addJob') tx.objectStore('jobs').delete(op.body.id); // the server never accepted this job
      tx.objectStore('queue').delete(seq);
      await tx.done;
      await db.put('meta', true, 'needFull'); // re-download so edits/status changes match the server again
    }
    await refreshCounts(); emit();
    return sync();
  }

  async function retryFailed() {
    const tx = db.transaction('queue', 'readwrite');
    for (const o of await tx.store.getAll()) if (o.failed) tx.store.put({ ...o, failed: false, error: undefined });
    await tx.done;
    await refreshCounts(); emit();
    return sync();
  }

  // ---------------- lifecycle ----------------
  async function init(initialConfig) {
    db = await open(dbName);
    const cached = await db.get('meta', 'config');
    if (initialConfig) { setConfig(initialConfig); await db.put('meta', initialConfig, 'config'); }
    else if (cached) setConfig(cached);
    if (!(await db.get('meta', 'seenAccepted'))) await db.put('meta', iso(), 'seenAccepted'); // only news from now on
    // A new version of the app re-downloads everything once, so old copies on phones can never drift from the server.
    const build = typeof __APP_BUILD__ === 'undefined' ? 'dev' : __APP_BUILD__;
    if ((await db.get('meta', 'build')) !== build) { await db.put('meta', true, 'needFull'); await db.put('meta', build, 'build'); }
    state.lastSyncAt = demo ? iso() : (await db.get('meta', 'lastSync')) ?? null;
    state.ready = demo || !!state.lastSyncAt;
    await refreshCounts(); emit();
  }

  function start() {
    if (typeof window === 'undefined') return () => {};
    const on = () => { state.reachable = true; emit(); sync(); };
    const off = () => { state.reachable = false; emit(); };
    const vis = () => { if (document.visibilityState === 'visible' && (!state.lastSyncAt || Date.now() - Date.parse(state.lastSyncAt) > 20_000)) sync(); };
    window.addEventListener('online', on); window.addEventListener('offline', off);
    document.addEventListener('visibilitychange', vis);
    const iv = setInterval(() => { if (document.visibilityState === 'visible') sync(); }, 180_000); // every 3 minutes while open (also on return and after every change)
    try { navigator.storage?.persist?.(); } catch { /* best effort: ask the browser not to evict our data */ }
    sync();
    const stop = () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); document.removeEventListener('visibilitychange', vis); clearInterval(iv); };
    stopFns.push(stop);
    return stop;
  }

  async function close() { stopFns.forEach((f) => f()); stopFns = []; clearTimeout(timer); if (running) await running; db?.close(); }

  return {
    init, start, close, sync, discard, retryFailed,
    board, bookings, clientCount, acceptances, dismissAcceptances, search, getCard, createClient, deleteClient, addJob, deleteJob, addPayment, removePayment, demoUpdateJob, setStatus, setSchedule, patchClient, patchJob,
    setQuote, saveCatalogItem, deleteCatalogItem, setTaxRate, saveBusiness,
    getConfig: () => config,
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    getSnapshot: () => snap,
  };
}
