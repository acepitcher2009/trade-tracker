export class ApiError extends Error {
  constructor(status, message, data) { super(message); this.status = status; this.data = data; }
}

const TIMEOUT_MS = 20_000; // spotty signal: fail (and retry later) rather than hang forever

async function fetchTransport(method, path, body, signal) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  signal?.addEventListener('abort', () => ctl.abort());
  try {
    const res = await fetch(`/api${path}`, {
      method, signal: ctl.signal, credentials: 'same-origin',
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON */ }
    return { status: res.status, data };
  } finally { clearTimeout(timer); }
}

// Swappable so tests can call the server handler directly.
let transport = fetchTransport;
export function setTransport(fn) { transport = fn ?? fetchTransport; }

export function makeApi(getTransport) {
  async function req(method, path, body, signal) {
    let r;
    try {
      r = await getTransport()(method, path, body, signal);
    } catch (e) {
      if (signal?.aborted) throw e;
      throw new ApiError(0, "Can't reach the server. Check your signal and try again.");
    }
    if (r.status < 200 || r.status >= 300) throw new ApiError(r.status, r.data?.error || 'Something went wrong', r.data);
    return r.data;
  }
  return {
    me: () => req('GET', '/me'),
    invite: (token) => req('GET', `/invite/${encodeURIComponent(token)}`),
    consumeInvite: (token) => req('POST', `/invite/${encodeURIComponent(token)}/consume`, {}),
    login: (slug, pin) => req('POST', '/login', { slug, pin }),
    logout: () => req('POST', '/logout', {}),
    sync: (since, { config = true } = {}) => req('GET', `/sync?${[since ? `since=${encodeURIComponent(since)}` : '', config ? '' : 'config=0'].filter(Boolean).join('&')}`),
    createClient: (body) => req('POST', '/clients', body),
    deleteClient: (id) => req('DELETE', `/clients/${id}`),
    patchClient: (id, body) => req('PATCH', `/clients/${id}`, body),
    addJob: (clientId, body) => req('POST', `/clients/${clientId}/jobs`, body),
    putQuote: (jobId, quote, jobTypeId) => req('PUT', `/jobs/${jobId}/quote`, { quote, ...(jobTypeId ? { job_type_id: jobTypeId } : {}) }),
    declineQuote: (token, reason) => req('POST', `/q/${encodeURIComponent(token)}/decline`, { ...(reason ? { reason } : {}) }),
    putCatalogItem: (id, body) => req('PUT', `/catalog/${id}`, body),
    deleteCatalogItem: (id) => req('DELETE', `/catalog/${id}`),
    patchBusiness: (body) => req('PATCH', '/business', body),
    publicQuote: (token) => req('GET', `/q/${encodeURIComponent(token)}`),
    acceptQuote: (token, name, selection, agree = true) => req('POST', `/q/${encodeURIComponent(token)}/accept`, { name, agree, ...(selection ? { selection } : {}) }),
    pushKey: () => req('GET', '/push/key'),
    pushSubscribe: (endpoint) => req('POST', '/push/subscribe', { endpoint }),
    pushUnsubscribe: (endpoint) => req('POST', '/push/unsubscribe', { endpoint }),
    patchJob: (jobId, fields) => req('PATCH', `/jobs/${jobId}`, fields),
    setStatus: (jobId, statusId, schedule) => req('PATCH', `/jobs/${jobId}`, {
      status_id: statusId,
      ...(schedule ? { scheduled_date: schedule.date ?? null, scheduled_time: schedule.time ?? null } : {}),
    }),
  };
}

export const api = makeApi(() => transport);

export function newId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
