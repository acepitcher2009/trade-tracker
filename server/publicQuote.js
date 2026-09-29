// The client-facing quote page's data. The link token is the credential (192 random bits); no session.
import { query } from './db.js';
import { HttpError, json } from './http.js';
import { str } from './validate.js';
import { notifyBusiness } from './push.js';
import { publicQuote as safeQuote, cleanSelection, computeQuote } from '../shared/quote.js';

const TOKEN = /^[A-Za-z0-9_-]{20,64}$/;

async function load(token) {
  if (!TOKEN.test(token)) return null;
  const [r] = await query(
    `select j.quote, j.declined_at, j.decline_reason, j.quote_accepted_at, j.quote_accepted_by, j.quote_selection, j.quote_accepted_total_cents, j.parent_job_id, jt.name as job_type,
            c.name as client_name, c.address_line, c.city, c.state, c.zip,
            b.id as business_id, (now() at time zone b.timezone)::date::text as biz_today, b.name as biz_name, b.license_no, b.quote_terms, b.phone_digits as biz_phone, b.city as biz_city, b.state as biz_state, b.accent_color
       from jobs j
       join clients c    on c.business_id = j.business_id and c.id = j.client_id
       left join job_types jt on jt.business_id = j.business_id and jt.id = j.job_type_id
       join businesses b on b.id = j.business_id
      where j.deleted_at is null and j.quote is not null and j.quote->>'token' = $1`, [token]);
  return r ?? null;
}

const view = (r) => ({
  business: { name: r.biz_name, license_no: r.license_no, quote_terms: r.quote_terms, phone_digits: r.biz_phone, city: r.biz_city, state: r.biz_state, accent_color: r.accent_color },
  client: { name: r.client_name, address: r.address_line ? `${r.address_line}, ${r.city}, ${r.state} ${r.zip}` : null },
  job_type: r.job_type ?? 'Quote',
  declined_at: r.declined_at ?? null,
  // Only customer-safe fields: never your unit costs, markup or private notes.
  quote: safeQuote(r.quote),
  selection: r.quote_selection ?? null, accepted_total_cents: r.quote_accepted_total_cents ?? null, change_order: !!r.parent_job_id,
  accepted_at: r.quote_accepted_at, accepted_by: r.quote_accepted_by,
  // A quote is good through the end of its last day, in the business's own time zone.
  expired: !!(r.quote.valid_until && r.quote.valid_until < r.biz_today && !r.quote_accepted_at),
});

export async function publicQuoteGet(token) {
  const r = await load(token);
  if (!r) throw new HttpError(404, 'This quote link is not valid.');
  return json(view(r));
}

export async function publicQuoteAccept(token, body, who = {}) {
  const r = await load(token);
  if (!r) throw new HttpError(404, 'This quote link is not valid.');
  const v = view(r);
  if (v.expired) throw new HttpError(410, 'This quote has expired. Please contact us for an updated one.');
  const name = str(body.name, 'name', { max: 120 });
  if (!r.quote_accepted_at && body.agree !== true) throw new HttpError(400, 'Please tick the box to confirm you agree.', { field: 'agree' });
  if (!r.quote_accepted_at) {
    const sel = cleanSelection(r.quote, body.selection);
    const total = computeQuote(r.quote, sel).total;
    const meta = { agreed: true, name, at: new Date().toISOString(), total_cents: total, ip: String(who.ip ?? '').slice(0, 64), user_agent: String(who.ua ?? '').slice(0, 300) };
    const done = await query(
      // Accepting moves the job to "Accepted" (so it shows up for a call-back) unless it is already further along.
      `update jobs set quote_accepted_at = now(), quote_accepted_by = $2, quote_selection = $3::jsonb, quote_accepted_total_cents = $4, quote_accept_meta = $5::jsonb, declined_at = null, decline_reason = null,
          scheduled_date = case when pre.k then null else scheduled_date end,
          scheduled_time = case when pre.k then null else scheduled_time end,
          status_id = case when pre.k then coalesce(
            (select a.id from statuses a where a.business_id = jobs.business_id and a.key = 'accepted'), status_id) else status_id end
        from (select (select s.key in ('new','visit','quoted') from statuses s
                       where s.business_id = j2.business_id and s.id = j2.status_id) as k, j2.id
                from jobs j2 where j2.quote is not null and j2.quote->>'token' = $1) pre
        where pre.id = jobs.id and jobs.deleted_at is null and jobs.quote is not null and jobs.quote->>'token' = $1 and jobs.quote_accepted_at is null returning jobs.id`, [token, name, JSON.stringify(sel), total, JSON.stringify(meta)]);
    if (done.length) await notifyBusiness(r.business_id); // tell the owner's phone (never fails the customer's accept)
  }
  return json(view(await load(token)));
}

/** The customer says no thanks. Kept on the job (with the reason, if they give one) until the owner clears it. */
export async function publicQuoteDecline(token, body) {
  const r = await load(token);
  if (!r) throw new HttpError(404, 'This quote link is not valid.');
  if (r.quote_accepted_at) throw new HttpError(409, 'This quote was already accepted. Please call us if that was a mistake.');
  const reason = str(body?.reason, 'reason', { max: 300, optional: true });
  if (!r.declined_at) {
    const done = await query(
      `update jobs set declined_at = now(), decline_reason = $2
        where deleted_at is null and quote is not null and quote->>'token' = $1 and quote_accepted_at is null and declined_at is null returning id`, [token, reason]);
    if (done.length) await notifyBusiness(r.business_id);
  }
  return json(view(await load(token)));
}
