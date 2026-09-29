// Quote v2: the math (no database), then the server (throwaway tenant on the dev database).
import './guard.js';
import '../scripts/lib/env.js';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { computeQuote, cleanSelection, defaultSelection, profitOf, publicQuote, totals, validateQuote } from '../shared/quote.js';
import { handle } from '../server/routes.js';
import { getPool } from '../scripts/lib/db.js';
import { createBusiness } from '../scripts/lib/tenant.js';
import { PRESETS } from '../db/presets.js';
import { TRADE_UI, tradeUi } from '../shared/trades.js';

const tok = () => `zt${randomBytes(12).toString('hex')}`;
const item = (o) => ({ name: 'x', unit: 'each', qty: 1, unit_price_cents: 0, ...o });

test('tax: only lines not marked "no tax" are taxed; discounts lower the taxable amount; the minimum charge is taxed in proportion', () => {
  const q = { tax_bps: 825, items: [item({ id: 'a', unit_price_cents: 10000 }), item({ id: 'b', kind: 'labor', unit_price_cents: 5000, taxable: false })] };
  let c = computeQuote(q);
  assert.equal(c.subtotal, 15000);
  assert.equal(c.taxableBase, 10000);
  assert.equal(c.tax, 825);
  assert.equal(c.total, 15825);
  // everything taxable (the default) behaves exactly as before
  c = computeQuote({ tax_bps: 825, items: [item({ id: 'a', unit_price_cents: 10000 }), item({ id: 'b', unit_price_cents: 5000 })] });
  assert.equal(c.tax, Math.round(15000 * 0.0825));
  // a discount comes off the taxable amount unless it is marked no-tax
  c = computeQuote({ tax_bps: 1000, items: [item({ id: 'a', unit_price_cents: 20000 }), item({ id: 'd', kind: 'discount', unit_price_cents: 5000 })] });
  assert.equal(c.taxableBase, 15000);
  assert.equal(c.tax, 1500);
  // minimum charge: half the work is taxable, so half of the top-up is
  c = computeQuote({ tax_bps: 1000, min_charge_cents: 30000, items: [item({ id: 'a', unit_price_cents: 10000 }), item({ id: 'b', unit_price_cents: 10000, taxable: false })] });
  assert.equal(c.subtotal, 30000);
  assert.equal(c.taxableBase, 15000);
  assert.equal(c.tax, 1500);
  // nothing taxable at all -> no tax, even with a minimum charge
  c = computeQuote({ tax_bps: 1000, min_charge_cents: 30000, items: [item({ id: 'a', unit_price_cents: 10000, taxable: false })] });
  assert.equal(c.tax, 0);
  // the flag survives validation and reaches the customer's copy (their page does the same math)
  const v = validateQuote({ token: 'x'.repeat(24), tax_bps: 825, items: [item({ name: 'Labor', unit_price_cents: 5000, taxable: false }), item({ name: 'Post', unit_price_cents: 1000 })] });
  assert.equal(v.ok, true);
  assert.equal(v.value.items[0].taxable, false);
  assert.equal('taxable' in v.value.items[1], false, 'taxable is the default and is not stored');
  assert.equal(publicQuote(v.value).items[0].taxable, false);
  assert.equal(totals(publicQuote(v.value)).tax, totals(v.value).tax);
});

test('math: discounts subtract, surcharges are a percent of work lines, minimum charge is its own adjustment', () => {
  let c = computeQuote({ items: [item({ id: 'a', unit_price_cents: 100000 }), item({ id: 'b', kind: 'discount', unit_price_cents: 5000 })] });
  assert.equal(c.subtotal, 95000);
  c = computeQuote({ items: [item({ id: 'a', unit_price_cents: 100000 }), item({ id: 'f', kind: 'fee', unit_price_cents: 7500 }), item({ id: 's', kind: 'surcharge', qty: 10 })] });
  assert.equal(c.lines.find((l) => l.id === 's').amount, 10000, 'percent applies to work lines, not to fees');
  assert.equal(c.subtotal, 117500);
  c = computeQuote({ items: [item({ id: 'a', unit_price_cents: 5000 })], min_charge_cents: 8900 });
  assert.equal(c.minimumAdjustment, 3900);
  assert.equal(c.subtotal, 8900);
  assert.equal(computeQuote({ items: [item({ id: 'a', unit_price_cents: 20000 })], min_charge_cents: 8900 }).minimumAdjustment, 0);
});

test('math: packages, optional extras, tax and payment steps always add up', () => {
  const q = {
    packages: [{ key: 'good', name: 'Good' }, { key: 'better', name: 'Better' }, { key: 'best', name: 'Best' }],
    items: [item({ id: 'g', group: 'good', unit_price_cents: 100000 }), item({ id: 'b', group: 'better', unit_price_cents: 150000 }), item({ id: 'x', group: 'best', unit_price_cents: 200000 }),
      item({ id: 'o', optional: true, unit_price_cents: 30000 })],
    tax_bps: 825, milestones: [{ label: 'Deposit', pct: 30 }, { label: 'Start', pct: 40 }, { label: 'Done', pct: 30 }],
  };
  assert.equal(defaultSelection(q).package, 'better');
  assert.equal(computeQuote(q).subtotal, 150000);
  assert.equal(computeQuote(q, { package: 'good', options: [] }).subtotal, 100000);
  const withOpt = computeQuote(q, { package: 'best', options: ['o'] });
  assert.equal(withOpt.subtotal, 230000);
  assert.equal(withOpt.schedule.reduce((n, s) => n + s.amount, 0), withOpt.total, 'payment steps add up to the total to the cent');
  assert.deepEqual(cleanSelection(q, { package: 'nope', options: ['o', 'zzz'] }), { package: 'better', options: ['o'] });
});

test('privacy: the customer version has no costs, no private notes, and still shows every charge', () => {
  const q = {
    token: tok(), internal_notes: 'gate code 1234', tax_bps: 825, deposit_pct: 50, min_charge_cents: 8900,
    items: [item({ id: 'a', name: 'Water heater', unit_price_cents: 100000, cost_cents: 60000 }), item({ id: 'f', name: 'Permit', kind: 'fee', unit_price_cents: 7500, cost_cents: 2000 })],
  };
  const v = validateQuote(q);
  assert.ok(v.ok);
  const pub = publicQuote(v.value);
  const s = JSON.stringify(pub);
  assert.ok(!s.includes('cost_cents') && !s.includes('internal_notes') && !s.includes('gate code') && !s.includes('token'));
  assert.equal(pub.items.length, 2);
  assert.equal(pub.min_charge_cents, 8900, 'the minimum charge is disclosed');
  assert.equal(totals(pub).total, totals(v.value).total, 'customer total equals contractor total');
  assert.equal(profitOf(v.value).margin, 40000, 'profit counts work lines with a cost; fees are not marked-up work');
});

test('validation: bad packages, milestones and lines are rejected', () => {
  const base = { token: tok(), items: [item({ name: 'Work', unit_price_cents: 100 })] };
  assert.ok(validateQuote(base).ok);
  assert.ok(!validateQuote({ ...base, milestones: [{ label: 'a', pct: 50 }, { label: 'b', pct: 40 }] }).ok, 'steps must be 100%');
  assert.ok(!validateQuote({ ...base, packages: [{ key: 'good', name: 'Good' }] }).ok, 'one package is not a choice');
  assert.ok(!validateQuote({ ...base, items: [item({ name: 'Work', group: 'good' })] }).ok, 'group must exist');
  const pk = [{ key: 'good', name: 'Good' }, { key: 'best', name: 'Best' }];
  assert.ok(!validateQuote({ ...base, packages: pk, items: [item({ name: 'Work', group: 'good', optional: true })] }).ok);
  assert.ok(!validateQuote({ ...base, items: [item({ name: 'Work', kind: 'markup' })] }).ok);
  assert.ok(!validateQuote({ ...base, items: [item({ name: 'Work', kind: 'surcharge', qty: 0 })] }).ok);
  assert.ok(!validateQuote({ ...base, items: [item({ name: 'Work', cost_cents: -1 })] }).ok);
});

test('presets: every trade is internally consistent', () => {
  assert.ok(Object.keys(PRESETS).length >= 15);
  for (const [k, p] of Object.entries(PRESETS)) {
    assert.ok(p.jobTypes.length >= 3, k);
    for (const [name, , dollars, type, kind = 'item'] of p.catalog) {
      assert.ok(name && dollars >= 0, `${k}: ${name}`);
      assert.ok(type === null || p.jobTypes.includes(type), `${k}: ${name} has an unknown job type`);
      assert.ok(['item', 'labor', 'allowance', 'fee', 'discount', 'surcharge'].includes(kind), `${k}: ${name}`);
    }
  }
});

test('builder tweaks: every trade has its own tools, and they cover what its price list uses', () => {
  for (const [k, p] of Object.entries(PRESETS)) {
    const ui = TRADE_UI[k];
    assert.ok(ui, `${k} has builder settings`);
    for (const [name, , , , kind = 'item'] of p.catalog) assert.ok(kind === 'item' || ui.kinds.includes(kind), `${k}: ${name} is a ${kind} but the builder hides that button`);
  }
  for (const k of Object.keys(PRESETS)) assert.ok(TRADE_UI[k].units.length >= 4, `${k} has a unit list`);
  assert.ok(TRADE_UI['junk-removal'].units.includes('load') && TRADE_UI.roofing.units.includes('sq'));
  assert.deepEqual(tradeUi('junk-removal').measure, ['load']);
  assert.ok(!tradeUi('fence').packages && tradeUi('hvac').packages);
  assert.deepEqual(tradeUi('unknown-trade').kinds, ['fee', 'discount']);
});

// ---- server -------------------------------------------------------------------------------
const skip = !process.env.DATABASE_URL && 'DATABASE_URL not set';
const pool = skip ? null : getPool();
const S = { slug: `zq-test-${randomBytes(3).toString('hex')}`, pin: String(Math.floor(100000 + Math.random() * 899999)) };
const ADDR = { address_line: '12 Oak St', city: 'Bryan', state: 'TX', zip: '77802' };
async function call(method, path, { body, cookie } = {}) {
  const res = await handle(new Request(`http://localhost/api${path}`, {
    method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), 'x-nf-client-connection-ip': '10.9.9.9' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }));
  const sc = res.headers.get('set-cookie');
  return { status: res.status, data: await res.json().catch(() => null), cookie: sc ? sc.split(';')[0] : null };
}
before(async () => {
  if (skip) return;
  await createBusiness(pool, { name: 'Quote Plumbing', slug: S.slug, preset: 'plumbing', pin: S.pin });
  const r = await call('POST', '/login', { body: { slug: S.slug, pin: S.pin } });
  S.cookie = r.cookie;
  S.me = (await call('GET', '/me', { cookie: S.cookie })).data;
});
after(async () => {
  if (skip) return;
  await pool.query('delete from businesses where slug = $1', [S.slug]);
  await pool.query('delete from login_attempts where key like $1', [`%${S.slug}%`]);
  await pool.end();
});

test('server: trade preset sets business defaults and typed price-list rows; settings and catalog kinds are validated', { skip }, async () => {
  const b = S.me.business;
  assert.equal(b.uses_visits, false);
  assert.equal(b.min_charge_cents, 8900);
  assert.equal(b.default_deposit_pct, 0);
  assert.ok(S.me.catalog.some((c) => c.kind === 'surcharge' && c.unit_price_cents === 5000), 'after-hours surcharge is 50.00%');
  assert.ok(S.me.catalog.every((c) => c.unit_cost_cents === null));

  const p = (body) => call('PATCH', '/business', { cookie: S.cookie, body });
  assert.equal((await p({ license_no: 'TX M-12345', quote_terms: 'One year labor warranty.', valid_days: 14, uses_visits: true, min_charge_cents: 10000 })).status, 200);
  const me = (await call('GET', '/me', { cookie: S.cookie })).data.business;
  assert.deepEqual([me.license_no, me.valid_days, me.uses_visits, me.min_charge_cents], ['TX M-12345', 14, true, 10000]);
  for (const bad of [{ valid_days: 0 }, { valid_days: 999 }, { default_deposit_pct: 101 }, { uses_visits: 'yes' }, { min_charge_cents: -1 }, { tax_rate_bps: 5000 }, {}]) {
    assert.equal((await p(bad)).status, 400, JSON.stringify(bad));
  }
  const id = crypto.randomUUID();
  const put = (body) => call('PUT', `/catalog/${id}`, { cookie: S.cookie, body });
  assert.equal((await put({ name: 'Trip fee', unit: 'job', unit_price_cents: 4500, kind: 'fee', unit_cost_cents: 1500 })).status, 200);
  const row = (await call('GET', '/me', { cookie: S.cookie })).data.catalog.find((c) => c.id === id);
  assert.deepEqual([row.kind, row.unit_cost_cents], ['fee', 1500]);
  assert.equal((await put({ name: 'Bad', unit: 'job', unit_price_cents: 1, kind: 'markup' })).status, 400);
});

test('server: multi-day, crew, repeat and change orders are saved, validated and synced', { skip }, async () => {
  const jt = S.me.job_types[0].id;
  const made = await call('POST', '/clients', { cookie: S.cookie, body: { ...ADDR, name: 'Job Extras', phone: '9795550901', job: { job_type_id: jt, duration_days: 3, assigned_to: 'Mike', recurrence: { every: 'month' } } } });
  const job = made.data.client.jobs[0];
  assert.deepEqual([job.duration_days, job.assigned_to, job.recurrence], [3, 'Mike', { every: 'month' }]);
  const patch = (body) => call('PATCH', `/jobs/${job.id}`, { cookie: S.cookie, body });
  const r = await patch({ duration_days: 2, assigned_to: null, recurrence: null });
  assert.deepEqual([r.data.job.duration_days, r.data.job.assigned_to, r.data.job.recurrence], [2, null, null]);
  for (const bad of [{ duration_days: 0 }, { duration_days: 61 }, { recurrence: { every: 'hour' } }]) assert.equal((await patch(bad)).status, 400, JSON.stringify(bad));

  const co = await call('POST', `/clients/${made.data.client.id}/jobs`, { cookie: S.cookie, body: { job_type_id: jt, parent_job_id: job.id, notes: 'Change order' } });
  assert.equal(co.status, 201);
  assert.equal(co.data.job.parent_job_id, job.id);
  assert.equal((await call('POST', `/clients/${made.data.client.id}/jobs`, { cookie: S.cookie, body: { job_type_id: jt, parent_job_id: crypto.randomUUID() } })).status, 400);
  const sync = (await call('GET', '/sync', { cookie: S.cookie })).data;
  assert.equal(sync.jobs.find((j) => j.id === co.data.job.id).parent_job_id, job.id);
  assert.equal(sync.config.business.license_no, 'TX M-12345');
});

test('server: customer page hides costs; accepting records the chosen package and options and the exact total', { skip }, async () => {
  const jt = S.me.job_types[0].id;
  const made = await call('POST', '/clients', { cookie: S.cookie, body: { ...ADDR, name: 'Pick Packages', phone: '9795550902', job: { job_type_id: jt } } });
  const job = made.data.client.jobs[0];
  const token = tok();
  const quote = {
    token, tax_bps: 825, deposit_pct: 50, valid_until: '2099-12-31', internal_notes: 'gate code 1234', scope: 'Remove old tank and install new.',
    exclusions: 'Drywall repair.', packages: [{ key: 'good', name: 'Good' }, { key: 'best', name: 'Best' }],
    items: [
      { id: 'a', name: 'Water heater 40 gal', unit: 'each', qty: 1, unit_price_cents: 100000, group: 'good', cost_cents: 60000 },
      { id: 'b', name: 'Water heater 50 gal', unit: 'each', qty: 1, unit_price_cents: 140000, group: 'best', cost_cents: 85000 },
      { id: 'c', name: 'Permit', unit: 'each', qty: 1, unit_price_cents: 7500, kind: 'fee' },
      { id: 'd', name: 'Expansion tank', unit: 'each', qty: 1, unit_price_cents: 12000, optional: true, cost_cents: 5000 },
      { id: 'e', name: 'Handling', unit: '%', qty: 10, unit_price_cents: 0, kind: 'surcharge' },
    ],
  };
  assert.equal((await call('PUT', `/jobs/${job.id}/quote`, { cookie: S.cookie, body: { quote } })).status, 200);

  const pub = await call('GET', `/q/${token}`);
  assert.equal(pub.status, 200);
  const raw = JSON.stringify(pub.data);
  for (const secret of ['cost_cents', 'internal_notes', 'gate code', token, '60000', '85000']) assert.ok(!raw.includes(secret), `public page leaks ${secret}`);
  assert.equal(pub.data.quote.items.length, 5, 'every charge is shown, including the fee and the surcharge');
  assert.equal(pub.data.quote.scope, 'Remove old tank and install new.');
  assert.equal(pub.data.business.license_no, 'TX M-12345');
  assert.equal(pub.data.business.quote_terms, 'One year labor warranty.');

  const acc = await call('POST', `/q/${token}/accept`, { body: { name: 'Pat Customer', agree: true, selection: { package: 'best', options: ['d', 'nope'] } } });
  assert.equal(acc.status, 200);
  assert.deepEqual(acc.data.selection, { package: 'best', options: ['d'] });
  const want = computeQuote(quote, { package: 'best', options: ['d'] });
  assert.equal(want.subtotal, 174700, 'independent check: 1400 + 75 fee + 120 extra + 10% of 1520');
  assert.equal(acc.data.accepted_total_cents, want.total);
  const card = (await call('GET', `/clients/${made.data.client.id}`, { cookie: S.cookie })).data.client.jobs[0];
  assert.equal(card.quote_accepted_total_cents, want.total);
  assert.equal(card.status_key, 'accepted');

  // changing the numbers clears the recorded choice
  await call('PUT', `/jobs/${job.id}/quote`, { cookie: S.cookie, body: { quote: { ...quote, deposit_pct: 25 } } });
  const after2 = (await call('GET', `/clients/${made.data.client.id}`, { cookie: S.cookie })).data.client.jobs[0];
  assert.equal(after2.quote_selection, null);
  assert.equal(after2.quote_accepted_total_cents, null);

  // a customer cannot pick something the quote does not offer
  const acc2 = await call('POST', `/q/${token}/accept`, { body: { name: 'Pat Customer', agree: true, selection: { package: 'platinum', options: ['zzz'] } } });
  assert.deepEqual(acc2.data.selection, { package: 'best', options: [] });
});
