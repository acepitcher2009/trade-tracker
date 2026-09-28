export class ApiError extends Error {
  constructor(status, message, data) { super(message); this.status = status; this.data = data; }
}

async function req(method, path, body, signal) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method, signal, credentials: 'same-origin',
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new ApiError(0, "Can't reach the server. Check your signal and try again.");
  }
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) throw new ApiError(res.status, data?.error || 'Something went wrong', data);
  return data;
}

export const api = {
  me: () => req('GET', '/me'),
  login: (slug, pin) => req('POST', '/login', { slug, pin }),
  logout: () => req('POST', '/logout', {}),
  lookup: (q, signal) => req('GET', `/lookup?q=${encodeURIComponent(q)}`, undefined, signal),
  createClient: (body) => req('POST', '/clients', body),
  getClient: (id) => req('GET', `/clients/${id}`),
  patchClient: (id, body) => req('PATCH', `/clients/${id}`, body),
  addJob: (clientId, body) => req('POST', `/clients/${clientId}/jobs`, body),
  setStatus: (jobId, statusId) => req('PATCH', `/jobs/${jobId}`, { status_id: statusId }),
};

export function newId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
