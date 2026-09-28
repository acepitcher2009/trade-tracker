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
import { parseLookup, normalizePhone } from '../shared/phone.js';

const CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const OVERLAP_MS = 30_000; // re-fetch a little history so slow commits are never missed
const iso = () => new Date().toISOString();

function open(name) {
  return openDB(name, 1, {
    upgrade(d) {
      d.createObjectStore('meta');
      const c = d.createObjectStore('clients', { keyPath: 'id' });
      c.createIndex('phone', 'phone_digits');
      c.createIndex('last4', 'last4');
      d.createObjectStore('jobs', { keyPath: 'id' }).createIndex('client', 'client_id');
      d.createObjectStore('queue', { keyPath: 'seq', autoIncrement: true });
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
  address: c.address ?? null, notes: c.notes ?? null, created_at: c.created_at, updated_at: c.updated_at,
});
const normJob = (j) => ({
  id: j.id, client_id: j.client_id, job_type_id: j.job_type_id, status_id: j.status_id,
  notes: j.notes ?? null, created_at: j.created_at, updated_at: j.updated_at,
});
const isTransient = (e) => !(e instanceof ApiError) || [0, 401, 403, 408, 429].includes(e.status) || e.status >= 500;

export function createData(slug, { api = defaultApi, dbName = `tt-${slug}`, autoSync = true } = {}) {
  let db, config = null, typeName = new Map(), statusById = new Map();
  let running = null, rerun = false, timer = null, stopFns = [];
  const aliases = new Map(); // local client id -> server client id after a same-phone merge
  const state = { reachable: true, syncing: false, pending: 0, failed: 0, failedOps: [], lastSyncAt: null, ready: false, authExpired: false, error: '' };
  let version = 0, snap = { ...state, version };
  const listeners = new Set();
  const emit = () => { snap = { ...state, version: ++version }; listeners.forEach((l) => l()); };

  const setConfig = (cfg) => {
    config = { business: cfg.business, job_types: cfg.job_types, job_types_all: cfg.job_types_all ?? cfg.job_types, statuses: cfg.statuses };
    typeName = new Map(config.job_types_all.map((t) => [t.id, t.name]));
    statusById = new Map(config.statuses.map((s) => [s.id, s]));
  };
  const hydrateJob = (j) => {
    const s = statusById.get(j.status_id);
    return { ...j, job_type: typeName.get(j.job_type_id) ?? 'Job', status_key: s?.key, status_label: s?.label ?? '?', status_color: s?.color };
  };

  const describe = (op) => ({
    createClient: `Add ${op.payload?.name ?? 'client'}`, addJob: 'Add job', setStatus: 'Change job status', patchClient: 'Edit client details',
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
      if (o.type === 'setStatus') out.jobs.add(o.jobId);
    }
    return out;
  }
  async function changed() {
    await refreshCounts(); emit();
    if (autoSync) { clearTimeout(timer); timer = setTimeout(() => sync(), 300); }
  }

  // ---------------- reads (local only) ----------------
  async function lookup(q) {
    const p = parseLookup(q);
    if (p.mode === 'partial') return { mode: 'partial', matches: [] };
    const rows = p.mode === 'full'
      ? await db.getAllFromIndex('clients', 'phone', p.digits)
      : await db.getAllFromIndex('clients', 'last4', p.last4);
    const pend = await pendingSets();
    const matches = [];
    for (const c of rows) {
      const jobs = (await db.getAllFromIndex('jobs', 'client', c.id)).sort(newest);
      const last = jobs[0] ? hydrateJob(jobs[0]) : null;
      matches.push({
        id: c.id, name: c.name, phone_digits: c.phone_digits, address: c.address, job_count: jobs.length,
        last_job_at: last?.created_at ?? null, last_job_type: last?.job_type ?? null, last_job_status: last?.status_label ?? null,
        pending: pend.clients.has(c.id) || jobs.some((j) => pend.jobs.has(j.id)),
      });
    }
    matches.sort((a, b) => a.name.localeCompare(b.name));
    return { mode: p.mode, matches: matches.slice(0, 10) };
  }

  async function getCard(id) {
    const rid = aliases.get(id) ?? id;
    const c = await db.get('clients', rid);
    if (!c) return null;
    const pend = await pendingSets();
    const jobs = (await db.getAllFromIndex('jobs', 'client', rid)).sort(newest).map(hydrateJob);
    return { ...c, jobs, pending: pend.clients.has(rid) || jobs.some((j) => pend.jobs.has(j.id)) };
  }

  // ---------------- writes (local + queue, atomically) ----------------
  function checkJobType(id) {
    if (!config.job_types.some((t) => t.id === id)) throw new Error('Pick a job type.');
  }

  async function addJob(clientId, { jobTypeId, notes } = {}) {
    checkJobType(jobTypeId);
    const cid = aliases.get(clientId) ?? clientId;
    const now = iso();
    const job = { id: newId(), client_id: cid, job_type_id: jobTypeId, status_id: config.statuses[0].id, notes: clean(notes, 4000), created_at: now, updated_at: now };
    const tx = db.transaction(['jobs', 'queue', 'clients'], 'readwrite');
    if (!(await tx.objectStore('clients').get(cid))) throw new Error('Client not found.');
    tx.objectStore('jobs').put(job);
    tx.objectStore('queue').add({ type: 'addJob', clientId: cid, body: { id: job.id, job_type_id: job.job_type_id, status_id: job.status_id, ...(job.notes ? { notes: job.notes } : {}) }, createdAt: now });
    await tx.done;
    await changed();
    return hydrateJob(job);
  }

  async function createClient({ name, phone, address, notes, jobTypeId }) {
    const nm = clean(name, 120);
    if (!nm) throw new Error('Enter a name.');
    const digits = normalizePhone(phone);
    if (!digits) throw new Error('Enter a valid 10-digit phone number.');
    const addr = clean(address, 300), nts = clean(notes, 4000);
    if (jobTypeId) checkJobType(jobTypeId);

    const existing = (await db.getAllFromIndex('clients', 'phone', digits))[0];
    if (existing) { // same number never makes a second client
      if (jobTypeId) await addJob(existing.id, { jobTypeId });
      return { created: false, client: await getCard(existing.id) };
    }
    const now = iso(), id = newId();
    const client = { id, name: nm, phone_digits: digits, last4: digits.slice(-4), address: addr, notes: nts, created_at: now, updated_at: now };
    const job = jobTypeId ? { id: newId(), client_id: id, job_type_id: jobTypeId, status_id: config.statuses[0].id, notes: null, created_at: now, updated_at: now } : null;
    const tx = db.transaction(['clients', 'jobs', 'queue'], 'readwrite');
    tx.objectStore('clients').put(client);
    if (job) tx.objectStore('jobs').put(job);
    tx.objectStore('queue').add({
      type: 'createClient', createdAt: now,
      payload: { id, name: nm, phone: digits, ...(addr ? { address: addr } : {}), ...(nts ? { notes: nts } : {}),
        ...(job ? { job: { id: job.id, job_type_id: job.job_type_id, status_id: job.status_id } } : {}) },
    });
    await tx.done;
    await changed();
    return { created: true, client: await getCard(id) };
  }

  async function setStatus(jobId, statusId) {
    if (!statusById.has(statusId)) throw new Error('Unknown status.');
    const tx = db.transaction(['jobs', 'queue'], 'readwrite');
    const job = await tx.objectStore('jobs').get(jobId);
    if (!job) throw new Error('Job not found.');
    tx.objectStore('jobs').put({ ...job, status_id: statusId, updated_at: iso() });
    for (const o of await tx.objectStore('queue').getAll()) { // only the latest tap per job needs to be sent
      if (o.type === 'setStatus' && o.jobId === jobId && !o.failed) tx.objectStore('queue').delete(o.seq);
    }
    tx.objectStore('queue').add({ type: 'setStatus', jobId, statusId, createdAt: iso() });
    await tx.done;
    await changed();
  }

  async function patchClient(id, fields) {
    const cid = aliases.get(id) ?? id;
    const patch = {};
    if ('name' in fields) { patch.name = clean(fields.name, 120); if (!patch.name) throw new Error('Name can’t be empty.'); }
    if ('address' in fields) patch.address = clean(fields.address, 300);
    if ('notes' in fields) patch.notes = clean(fields.notes, 4000);
    if (!Object.keys(patch).length) return;
    const tx = db.transaction(['clients', 'queue'], 'readwrite');
    const c = await tx.objectStore('clients').get(cid);
    if (!c) throw new Error('Client not found.');
    tx.objectStore('clients').put({ ...c, ...patch, updated_at: iso() });
    let merged = patch;
    for (const o of await tx.objectStore('queue').getAll()) {
      if (o.type === 'patchClient' && o.clientId === cid && !o.failed) { merged = { ...o.fields, ...patch }; tx.objectStore('queue').delete(o.seq); }
    }
    tx.objectStore('queue').add({ type: 'patchClient', clientId: cid, fields: merged, createdAt: iso() });
    await tx.done;
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
      case 'setStatus': await api.setStatus(op.jobId, op.statusId); break;
      case 'patchClient': await api.patchClient(op.clientId, op.fields); break;
      default: throw new ApiError(400, `Unknown change type ${op.type}`);
    }
  }

  async function push() {
    for (;;) {
      const op = (await db.getAll('queue')).filter((o) => !o.failed).sort((a, b) => a.seq - b.seq)[0];
      if (!op) return;
      try {
        await sendOp(op);
        await db.delete('queue', op.seq);
      } catch (e) {
        if (isTransient(e)) throw e; // keep the queue intact, order preserved, try again later
        await db.put('queue', { ...op, failed: true, error: e.message }); // server said no: park it, keep going
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
      jobs.put(normJob(j));
    }
    await tx.done;
  }

  async function pull(full) {
    let since = full ? null : (await db.get('meta', 'since')) ?? null;
    for (let page = 0; page < 200; page++) {
      const r = await api.sync(since);
      setConfig(r.config); await db.put('meta', r.config, 'config');
      await applyPull(r, await pendingSets());
      if (!r.more) {
        await db.put('meta', new Date(Date.parse(r.server_time) - OVERLAP_MS).toISOString(), 'since');
        state.lastSyncAt = iso(); await db.put('meta', state.lastSyncAt, 'lastSync');
        state.ready = true;
        return;
      }
      if (!r.next_since || r.next_since === since) throw new ApiError(500, 'Sync could not page forward');
      since = r.next_since;
    }
  }

  function sync({ full = false } = {}) {
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
    state.lastSyncAt = (await db.get('meta', 'lastSync')) ?? null;
    state.ready = !!state.lastSyncAt;
    await refreshCounts(); emit();
  }

  function start() {
    if (typeof window === 'undefined') return () => {};
    const on = () => { state.reachable = true; emit(); sync(); };
    const off = () => { state.reachable = false; emit(); };
    const vis = () => { if (document.visibilityState === 'visible') sync(); };
    window.addEventListener('online', on); window.addEventListener('offline', off);
    document.addEventListener('visibilitychange', vis);
    const iv = setInterval(() => { if (document.visibilityState === 'visible') sync(); }, 60_000);
    try { navigator.storage?.persist?.(); } catch { /* best effort: ask the browser not to evict our data */ }
    sync();
    const stop = () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); document.removeEventListener('visibilitychange', vis); clearInterval(iv); };
    stopFns.push(stop);
    return stop;
  }

  async function close() { stopFns.forEach((f) => f()); stopFns = []; clearTimeout(timer); if (running) await running; db?.close(); }

  return {
    init, start, close, sync, discard, retryFailed,
    lookup, getCard, createClient, addJob, setStatus, patchClient,
    getConfig: () => config,
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    getSnapshot: () => snap,
  };
}
