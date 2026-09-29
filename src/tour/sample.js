// The guided tour's pretend customers. They live only in the tour's own database on this phone (see createData's `demo`
// option) and are deleted when the tour ends. The phone numbers are the reserved 555-01xx range, so they never reach a real person.
import { addDays, todayStr } from '../format.js';

const ADDR = { addressLine: '100 Sample Rd', city: 'Anytown', state: 'TX', zip: '77000' };
const tok = () => { const b = crypto.getRandomValues(new Uint8Array(24)); return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };

/** Fill a fresh tour database: one pretend customer at each stage of the work. */
export async function seedTour(data, cfg) {
  const st = (key) => cfg.statuses.find((s) => s.key === key)?.id;
  const jobType = cfg.job_types[0]?.id;
  const svc = cfg.catalog.find((c) => (c.kind ?? 'item') === 'item' && (!c.job_type_id || c.job_type_id === jobType)) ?? cfg.catalog.find((c) => (c.kind ?? 'item') === 'item');
  const quote = (cents, sentDaysAgo) => ({
    token: tok(), tax_bps: cfg.business.tax_rate_bps || 0, deposit_pct: 0, valid_until: addDays(todayStr(), 30),
    items: [{ id: 'sample1', name: svc?.name ?? 'Sample service', unit: svc?.unit ?? 'each', qty: 1, unit_price_cents: cents, kind: 'item' }],
    ...(sentDaysAgo != null ? { sent_at: new Date(Date.now() - sentDaysAgo * 86400000).toISOString() } : {}),
  });
  const price = Math.max(100, Math.round(svc?.unit_price_cents || 120000));
  const who = async (name, phone) => (await data.createClient({ name, phone, ...ADDR })).client;
  const at = (client) => client.jobs[0];
  const today = todayStr();
  const tomorrow = addDays(today, 1);

  await who('Sample: Dana Rivers', '9795550111');                                   // a new call, waiting for a site visit

  const mike = await data.createClient({ name: 'Sample: Mike Turner', phone: '9795550122', ...ADDR, schedule: { date: today, time: '10:00' } });   // site visit today
  void mike;

  const priya = at(await who('Sample: Priya Shah', '9795550133'));                  // quote sent four days ago, no answer yet
  await data.setQuote(priya.id, quote(price, 4), jobType);

  const luis = at(await who('Sample: Luis Ortega', '9795550144'));                  // said yes, needs a job date
  await data.setQuote(luis.id, quote(Math.round(price * 1.3), 3), jobType);
  await data.demoUpdateJob(luis.id, { status_id: st('accepted'), quote_accepted_at: new Date().toISOString(), quote_accepted_by: 'Luis Ortega' });

  const ann = at(await who('Sample: Ann Brooks', '9795550155'));                    // job booked for tomorrow
  await data.setQuote(ann.id, quote(Math.round(price * 0.8), 6), jobType);
  await data.demoUpdateJob(ann.id, { status_id: st('scheduled'), quote_accepted_at: new Date(Date.now() - 5 * 86400000).toISOString(), quote_accepted_by: 'Ann Brooks', scheduled_date: tomorrow, scheduled_time: '09:00' });

  const tom = at(await who('Sample: Tom Nguyen', '9795550166'));                    // finished, waiting to be paid
  await data.setQuote(tom.id, quote(price + 15000, 12), jobType);
  await data.demoUpdateJob(tom.id, { status_id: st('done'), quote_accepted_at: new Date(Date.now() - 10 * 86400000).toISOString(), quote_accepted_by: 'Tom Nguyen' });
}
