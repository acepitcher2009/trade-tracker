// "A customer accepted your quote" alerts to the owner's phone, using standard Web Push (VAPID) with no extra
// packages and no paid service. The push carries no message body; the app's service worker asks /api/push/latest
// for the details (with the owner's own session), so nothing private travels through the push service.
import { createPrivateKey, createSign } from 'node:crypto';
import { query } from './db.js';
import { HttpError, json, readJson } from './http.js';

const b64u = (b) => Buffer.from(b).toString('base64url');
const fromB64u = (s) => Buffer.from(s, 'base64url');

// Only real push services (stops anyone pointing our server at an arbitrary address).
const HOSTS = [/(^|\.)googleapis\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/];
export const okEndpoint = (u) => {
  try { const x = new URL(u); return x.protocol === 'https:' && u.length <= 600 && HOSTS.some((re) => re.test(x.hostname)); } catch { return false; }
};

export const publicKey = () => process.env.VAPID_PUBLIC_KEY || '';
const configured = () => !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);

/** A signed VAPID token for one push service ("aud"), valid 12 hours. */
export function vapidJwt(audience, now = Date.now()) {
  const pub = fromB64u(process.env.VAPID_PUBLIC_KEY);
  const key = createPrivateKey({ format: 'jwk', key: {
    kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)), d: process.env.VAPID_PRIVATE_KEY } });
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64u(JSON.stringify({ aud: audience, exp: Math.floor(now / 1000) + 12 * 3600, sub: process.env.VAPID_SUBJECT || 'https://trade-tracker-demo.netlify.app' }));
  const sig = createSign('SHA256').update(`${head}.${body}`).sign({ key, dsaEncoding: 'ieee-p1363' });
  return `${head}.${body}.${b64u(sig)}`;
}

/** Ping every phone this business has turned alerts on for. Never throws: a failed alert must not break accepting a quote. */
export async function notifyBusiness(businessId, send = fetch) {
  if (!configured()) return 0;
  try {
    const subs = await query('select endpoint from push_subscriptions where business_id = $1', [businessId]);
    let sent = 0;
    await Promise.allSettled(subs.map(async ({ endpoint }) => {
      const res = await send(endpoint, {
        method: 'POST', signal: AbortSignal.timeout(4000),
        headers: { Authorization: `vapid t=${vapidJwt(new URL(endpoint).origin)}, k=${publicKey()}`, TTL: '86400', Urgency: 'high', 'Content-Length': '0' },
      });
      if (res.status === 404 || res.status === 410) await query('delete from push_subscriptions where endpoint = $1', [endpoint]);
      else if (res.ok) sent++;
    }));
    return sent;
  } catch { return 0; }
}

export async function pushKey() {
  if (!configured()) throw new HttpError(404, 'Alerts are not set up on this server.');
  return json({ key: publicKey() });
}

export async function pushSubscribe({ businessId }, req) {
  const b = await readJson(req);
  const endpoint = String(b.endpoint ?? '');
  if (!okEndpoint(endpoint)) throw new HttpError(400, 'That device cannot receive alerts.', { field: 'endpoint' });
  const [n] = await query('select count(*)::int as n from push_subscriptions where business_id = $1 and endpoint <> $2', [businessId, endpoint]);
  if (n.n >= 10) throw new HttpError(400, 'Too many devices already get alerts. Turn some off first.');
  await query(
    `insert into push_subscriptions (endpoint, business_id) values ($1, $2)
     on conflict (endpoint) do update set business_id = excluded.business_id`, [endpoint, businessId]);
  return json({ ok: true });
}

export async function pushUnsubscribe({ businessId }, req) {
  const b = await readJson(req);
  await query('delete from push_subscriptions where business_id = $1 and endpoint = $2', [businessId, String(b.endpoint ?? '')]);
  return json({ ok: true });
}

/** What the alert says: the newest quote accepted or declined in the last two days. */
export async function pushLatest({ businessId }) {
  const [r] = await query(
    `select * from (
       select 'accepted' as kind, c.name, j.quote_accepted_total_cents as total_cents, j.quote_accepted_at as at
         from jobs j join clients c on c.business_id = j.business_id and c.id = j.client_id
        where j.business_id = $1 and j.deleted_at is null and j.quote_accepted_at > now() - interval '2 days'
       union all
       select 'declined', c.name, null, j.declined_at
         from jobs j join clients c on c.business_id = j.business_id and c.id = j.client_id
        where j.business_id = $1 and j.deleted_at is null and j.declined_at > now() - interval '2 days'
     ) x order by at desc limit 1`, [businessId]);
  return json(r ?? {});
}
