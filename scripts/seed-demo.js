// Adds 10 FAKE demo clients (with jobs) to deno-fence-and-stain. Idempotent: clients whose
// phone already exists are skipped. Refuses to run unless the database is marked as the dev branch.
// Usage: npm run seed-demo
import { getPool, fail } from './lib/db.js';
import { assertDev } from './lib/guard.js';
import { randomBytes } from 'node:crypto';
import { normalizePhone } from '../shared/phone.js';

const SLUG = 'deno-fence-and-stain';
await assertDev(); // refuses unless the database is marked as the dev branch

const dateIn = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const nextThursday = () => { const d = new Date(); return dateIn(((4 - d.getUTCDay() + 7) % 7) || 7); };
const day = (n) => new Date(Date.now() - n * 86400000).toISOString();
// [name, phone, [street, city, state, zip], notes, [ [jobType, statusKey, notes, daysAgo, schedule?], ... ]]  schedule = [dateString, 'HH:MM']
const DEMO = [
  ['Maria Gonzales', '(979) 555-0142', ['1204 Live Oak Dr', 'Bryan', 'TX', '77802'], 'Prefers text over calls. Gate code 4471.',
    [['Fence Installation', 'paid', '6 ft cedar privacy, 180 ft. Paid in full.', 120], ['Staining & Sealing', 'scheduled', 'Re-stain in spring, semi-transparent cedar tone.', 3, [dateIn(3), '13:00']]]],
  ['Tom Whitaker', '(936) 555-0142', ['88 County Rd 312', 'Caldwell', 'TX', '77836'], 'Same last 4 as Maria Gonzales (demo of last-4 lookup). Has two dogs; call before arriving.',
    [['Repair', 'quoted', 'Three rotted posts on north side; quoted $640.', 2]]],
  ['Darlene Prescott', '(979) 555-0177', ['3310 Rock Prairie Rd', 'College Station', 'TX', '77845'], 'Referred by Maria Gonzales.',
    [['Fence Installation', 'scheduled', '4 ft picket, front yard, 90 ft. Start Thursday.', 1, [nextThursday(), '08:00']]]],
  ['James Okafor', '(979) 555-0163', ['715 Villa Maria Rd', 'Bryan', 'TX', '77801'], null,
    [['Staining & Sealing', 'done', 'Sealed 140 ft. Waiting on payment.', 5]]],
  ['Linda Barrera', '(281) 555-0119', ['502 Elm St', 'Navasota', 'TX', '77868'], 'Rental property; bill goes to her, not the tenant.',
    [['Repair', 'paid', 'Replaced 8 pickets and a gate latch.', 45], ['Repair', 'done', 'Gate sagging again, re-hung and braced.', 6]]],
  ['Ray Kowalski', '(979) 555-0128', ['4901 Old Reliance Rd', 'Bryan', 'TX', '77808'], 'Call after 5pm only.',
    [['Fence Installation', 'quoted', 'Chain-link to wood conversion, 220 ft. Quote sent, thinking it over.', 8]]],
  ['Hannah Cho', '(713) 555-0186', ['12 Beaver Creek Ln', 'Caldwell', 'TX', '77836'], 'New build, wants horse-safe fencing (no barbed wire).',
    [['Fence Installation', 'quoted', 'Pipe and 3-rail, 400 ft, quoted $9,800.', 4]]],
  ['Walt Henderson', '(979) 555-0104', ['2207 Texas Ave S', 'College Station', 'TX', '77840'], 'Repeat customer since 2022.',
    [['Fence Installation', 'paid', '2022: 150 ft cedar.', 400], ['Staining & Sealing', 'paid', '2024 re-stain.', 190], ['Repair', 'scheduled', 'Storm damage, 3 panels. Tomorrow 9am.', 2, [dateIn(1), '09:00']]]],
  ['Priya Nair', '(979) 555-0195', ['910 Southwest Pkwy', 'College Station', 'TX', '77840'], null,
    [['Staining & Sealing', 'quoted', 'Deck rail + fence, 60 ft. Waiting on HOA color approval.', 10]]],
  ['Carla Mendez', '(979) 555-0133', ['640 Harvey Mitchell Pkwy', 'Bryan', 'TX', '77807'], 'Called about a backyard privacy fence.',
    [['Fence Installation', 'visit', 'Site visit to measure and quote a 120 ft privacy fence.', 1, [dateIn(1), '10:30']]]],
  ['Sam Whitfield', '(979) 555-0158', ['1500 Wellborn Rd', 'College Station', 'TX', '77840'], 'Accepted the quote by text. Call to set the job date.',
    [['Fence Installation', 'accepted', 'Cedar picket, 100 ft. Customer accepted the quote.', 3]]],
  ['Eddie Ramirez', '(936) 555-0151', ['77 Private Rd 4020', 'Madisonville', 'TX', '77864'], 'Cash only. Long driveway, park by the mailbox.',
    [['Repair', 'done', 'Fixed leaning corner post with concrete.', 7], ['Fence Installation', 'new', 'Called yesterday wanting a price on 60 ft of privacy fence.', 1]]],
];

// Sample quotes for the demo jobs, keyed by the job's notes: [[price-list item, qty], ...], deposit %, accepted?
const QUOTES = {
  'Re-stain in spring, semi-transparent cedar tone.': { lines: [['Power wash and prep', 120], ['Stain and seal, one side', 120], ['Second coat', 120]], dep: 25, acc: 'Maria Gonzales' },
  'Cedar picket, 100 ft. Customer accepted the quote.': { lines: [['4 ft cedar picket fence', 100]], dep: 50, acc: 'Sam Whitfield', ago: 2 },
  'Three rotted posts on north side; quoted $640.': { lines: [['Replace post, set in concrete', 3], ['Service call', 1]], dep: 0 },
  '4 ft picket, front yard, 90 ft. Start Thursday.': { lines: [['4 ft cedar picket fence', 90], ['Walk gate', 1]], dep: 50, acc: 'Darlene Prescott' },
  'Sealed 140 ft. Waiting on payment.': { lines: [['Power wash and prep', 140], ['Stain and seal, one side', 140]], dep: 0, sent: true },
  'Gate sagging again, re-hung and braced.': { lines: [['Gate repair or re-hang', 1], ['Service call', 1]], dep: 0, acc: 'Linda Barrera' },
  'Chain-link to wood conversion, 220 ft. Quote sent, thinking it over.': { lines: [['Old fence tear-out and haul-off', 220], ['6 ft cedar privacy fence', 220], ['Walk gate', 1]], dep: 50, sent: true },
  'Pipe and 3-rail, 400 ft, quoted $9,800.': { lines: [['Pipe and 3-rail (horse fence)', 400], ['Double drive gate', 1]], dep: 50, sent: true },
  'Storm damage, 3 panels. Tomorrow 9am.': { lines: [['Panel section repair', 3], ['Service call', 1]], dep: 0, acc: 'Walt Henderson' },
  'Deck rail + fence, 60 ft. Waiting on HOA color approval.': { lines: [['Stain and seal, one side', 60], ['Deck stain and seal', 80]], dep: 0, sent: true },
  '6 ft cedar privacy, 180 ft. Paid in full.': { lines: [['6 ft cedar privacy fence', 180], ['Walk gate', 1]], dep: 50, acc: 'Maria Gonzales' },
  'Replaced 8 pickets and a gate latch.': { lines: [['Replace fence picket', 8], ['Gate repair or re-hang', 1]], dep: 0, acc: 'Linda Barrera' },
  '2022: 150 ft cedar.': { lines: [['6 ft cedar privacy fence', 150]], dep: 50, acc: 'Walt Henderson' },
  '2024 re-stain.': { lines: [['Stain and seal, one side', 150]], dep: 0, acc: 'Walt Henderson' },
  'Fixed leaning corner post with concrete.': { lines: [['Replace post, set in concrete', 1], ['Service call', 1]], dep: 0, acc: 'Eddie Ramirez' },
};

const pool = getPool();
try {
  const { rows: [biz] } = await pool.query('select id from businesses where slug = $1', [SLUG]);
  if (!biz) throw new Error(`Business "${SLUG}" not found. Run npm run seed first.`);
  const types = Object.fromEntries((await pool.query('select id, name from job_types where business_id=$1', [biz.id])).rows.map(r => [r.name, r.id]));
  const stats = Object.fromEntries((await pool.query('select id, key from statuses where business_id=$1', [biz.id])).rows.map(r => [r.key, r.id]));
  let added = 0, skipped = 0;
  for (const [name, phone, address, notes, jobs] of DEMO) {
    const digits = normalizePhone(phone);
    const ins = await pool.query(
      `insert into clients (business_id, name, phone_digits, address_line, city, state, zip, notes, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict (business_id, phone_digits) do nothing returning id`,
      [biz.id, name, digits, address[0], address[1], address[2], address[3], notes, day(Math.max(...jobs.map(j => j[3])) + 1)]);
    if (!ins.rows.length) { skipped++; continue; }
    added++;
    for (const [type, status, jn, ago, sch] of jobs) {
      if (!types[type] || !stats[status]) throw new Error(`Unknown job type/status: ${type}/${status}`);
      await pool.query(
        `insert into jobs (business_id, client_id, job_type_id, status_id, notes, created_at, updated_at, scheduled_date, scheduled_time)
         values ($1,$2,$3,$4,$5,$6,now(),$7::date,$8::time)`, [biz.id, ins.rows[0].id, types[type], stats[status], jn, day(ago), sch?.[0] ?? null, sch?.[1] ?? null]);
    }
  }
  // Sample itemized quotes from the price list (only jobs that have none yet).
  const { rows: cat } = await pool.query('select name, unit, unit_price_cents from catalog_items where business_id = $1 and active', [biz.id]);
  const byName = Object.fromEntries(cat.map((c) => [c.name, c]));
  const { rows: tax } = await pool.query('select tax_rate_bps from businesses where id = $1', [biz.id]);
  let quoted = 0;
  for (const [notes, q] of Object.entries(QUOTES)) {
    const items = q.lines.map(([n, qty]) => {
      const c = byName[n];
      if (!c) throw new Error(`Price list item missing: ${n}. Run: npm run seed-catalog -- ${SLUG}`);
      return { name: c.name, unit: c.unit, qty, unit_price_cents: c.unit_price_cents };
    });
    const quote = { token: randomBytes(24).toString('base64url'), items, tax_bps: tax[0].tax_rate_bps, deposit_pct: q.dep,
      valid_until: dateIn(30), notes: 'Thanks for the opportunity. Price good for 30 days.', sent_at: q.sent || q.acc ? new Date().toISOString() : null };
    const r = await pool.query(
      `update jobs set quote = $3::jsonb, quote_accepted_at = $4, quote_accepted_by = $5, updated_at = now()
        where business_id = $1 and notes = $2 and quote is null`,
      [biz.id, notes, JSON.stringify(quote), q.acc ? new Date(Date.now() - (q.ago ?? 0) * 86400000).toISOString() : null, q.acc ?? null]);
    quoted += r.rowCount;
  }
  if (quoted) console.log(`Added sample quotes to ${quoted} demo job(s).`);
  // Demo clients seeded before structured addresses existed: complete them (only rows with no full address yet).
  let addrFilled = 0;
  for (const [, phone, a] of DEMO) {
    const r = await pool.query(
      `update clients set address_line = $3, city = $4, state = $5, zip = $6, updated_at = now()
        where business_id = $1 and phone_digits = $2 and address_line is null`, [biz.id, normalizePhone(phone), ...a]);
    addrFilled += r.rowCount;
  }
  if (addrFilled) console.log(`Added full addresses to ${addrFilled} existing demo client(s).`);
  // Also fill in dates on demo jobs seeded before scheduling existed (only rows with no date yet).
  let filled = 0;
  for (const [, phone, , , jobs] of DEMO) {
    for (const [, status, jn, , sch] of jobs) {
      if (!sch) continue;
      const r = await pool.query(
        `update jobs j set scheduled_date = $4::date, scheduled_time = $5::time, updated_at = now()
           from clients c
          where c.business_id = $1 and c.phone_digits = $2 and j.business_id = c.business_id and j.client_id = c.id
            and j.notes = $3 and j.scheduled_date is null and j.status_id = $6`,
        [biz.id, normalizePhone(phone), jn, sch[0], sch[1], stats[status]]);
      filled += r.rowCount;
    }
  }
  if (filled) console.log(`Added dates to ${filled} existing scheduled demo job(s).`);
  console.log(`Demo clients added: ${added}, already present (skipped): ${skipped}.`);
} catch (e) { fail(e); } finally { await pool.end(); }
