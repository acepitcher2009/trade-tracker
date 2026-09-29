export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export function json(data, status = 200, headers = {}) {
  const h = new Headers({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  for (const [k, v] of Object.entries(headers)) for (const one of [].concat(v)) h.append(k, one); // set-cookie may be a list
  return new Response(JSON.stringify(data), { status, headers: h });
}

/** Mutating requests must be JSON (forces a CORS preflight for cross-site callers). */
export async function readJson(req) {
  const ct = (req.headers.get('content-type') || '').toLowerCase();
  if (!ct.startsWith('application/json')) throw new HttpError(415, 'Content-Type must be application/json');
  const text = await req.text();
  if (text.length > 100_000) throw new HttpError(413, 'Request body too large');
  if (!text) return {};
  let v;
  try { v = JSON.parse(text); } catch { throw new HttpError(400, 'Invalid JSON body'); }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, 'Body must be a JSON object');
  return v;
}

/** Reject cross-site mutations: if an Origin header is present it must match this host. */
export function assertSameOrigin(req) {
  const origin = req.headers.get('origin');
  if (!origin) return;
  let host;
  try { host = new URL(origin).host; } catch { throw new HttpError(403, 'Bad origin'); }
  const mine = req.headers.get('host') || new URL(req.url).host;
  if (host !== mine) throw new HttpError(403, 'Cross-origin request blocked');
}

export function clientIp(req, context) {
  return req.headers.get('x-nf-client-connection-ip')
    || context?.ip
    || req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || 'unknown';
}
