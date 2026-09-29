// Quote math + validation shared by the server and the app, so both always agree on the numbers.
// Money is whole cents. A quote is one JSON document (all fields below except token are optional):
//
//  { token, sent_at, valid_until, notes, scope, exclusions, tax_bps, deposit_pct, milestones, min_charge_cents,
//    show_unit_prices, packages: [{ key, name, blurb }],
//    items: [{ id, name, unit, qty, unit_price_cents, kind, optional, group, note, cost_cents, taxable }],   (taxable: false = no sales tax on this line)
//    internal_notes }
//
// PRIVATE to the contractor (never sent to the customer, see publicQuote): cost_cents, internal_notes.
// EVERYTHING ELSE that changes the price is shown to the customer: every line, fee, surcharge, minimum-charge
// adjustment, discount, tax, and payment schedule. The customer's total is built only from lines they can see.
//
// Line kinds: item (default) | labor | allowance | fee | discount (subtracts) | surcharge (qty = percent of the
// item/labor/allowance lines, shown as its own line).

export const money = (cents) => (Number(cents || 0) / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

export const KINDS = ['item', 'labor', 'allowance', 'fee', 'discount', 'surcharge'];
export const KIND_LABEL = { item: 'Item', labor: 'Labor', allowance: 'Allowance', fee: 'Fee', discount: 'Discount', surcharge: 'Surcharge' };
const BASE_KINDS = new Set(['item', 'labor', 'allowance']); // what a percent surcharge applies to

/** Amount of one line in cents (negative for a discount). Surcharges need the base, see computeQuote. */
export const lineTotal = (it, base = 0) => {
  const kind = it.kind || 'item';
  if (kind === 'surcharge') return Math.round((base * Number(it.qty)) / 100);
  const v = Math.round(Number(it.qty) * Number(it.unit_price_cents));
  return kind === 'discount' ? -v : v;
};

/** Which choice the customer sees first: the middle package (or the only one), no optional add-ons. */
export function defaultSelection(q) {
  const pk = q?.packages ?? [];
  return { package: pk.length ? pk[Math.min(1, pk.length - 1)].key : null, options: [] };
}

/** Clamp a customer's choice to what this quote actually offers. */
export function cleanSelection(q, raw) {
  const d = defaultSelection(q);
  const pk = q?.packages ?? [];
  const pkg = pk.some((p) => p.key === raw?.package) ? raw.package : d.package;
  const optIds = new Set((q?.items ?? []).filter((i) => i.optional).map((i) => i.id));
  const options = Array.isArray(raw?.options) ? [...new Set(raw.options.filter((id) => optIds.has(id)))] : [];
  return { package: pkg, options };
}

const isIncluded = (it, sel) => (it.optional ? sel.options.includes(it.id) : it.group ? it.group === sel.package : true);

/** Full breakdown for a selection. `lines` lists every line (with included true/false) so pages can show options. */
export function computeQuote(q, selection) {
  const sel = selection ? cleanSelection(q, selection) : defaultSelection(q);
  const items = q?.items ?? [];
  const inc = items.filter((it) => isIncluded(it, sel));
  const base = inc.filter((it) => BASE_KINDS.has(it.kind || 'item')).reduce((n, it) => n + lineTotal(it), 0);
  const lines = items.map((it) => {
    const included = isIncluded(it, sel);
    return { ...it, kind: it.kind || 'item', included, amount: lineTotal(it, base) };
  });
  let subtotal = lines.filter((l) => l.included).reduce((n, l) => n + l.amount, 0);
  // Sales tax applies to lines not marked "no tax" (a discount lowers the taxable amount too).
  let taxableBase = lines.filter((l) => l.included && l.taxable !== false).reduce((n, l) => n + l.amount, 0);
  let minimumAdjustment = 0;
  const min = q?.min_charge_cents ?? 0;
  if (min > 0 && subtotal < min) {
    minimumAdjustment = min - subtotal;
    taxableBase += Math.round(subtotal > 0 ? (minimumAdjustment * taxableBase) / subtotal : minimumAdjustment); // taxed in the same proportion as the rest
    subtotal = min;
  }
  taxableBase = Math.max(0, taxableBase);
  const tax = Math.round((taxableBase * (q?.tax_bps ?? 0)) / 10000);
  const total = subtotal + tax;
  const ms = q?.milestones ?? [];
  let schedule;
  if (ms.length) {
    let left = total;
    schedule = ms.map((m, i) => {
      const amount = i === ms.length - 1 ? left : Math.round((total * m.pct) / 100);
      left -= amount;
      return { label: m.label, pct: m.pct, amount };
    });
  } else {
    const dep = Math.round((total * (q?.deposit_pct ?? 0)) / 100);
    schedule = dep > 0 ? [{ label: 'Deposit', pct: q.deposit_pct, amount: dep }, { label: 'Balance', pct: 100 - q.deposit_pct, amount: total - dep }]
      : [{ label: 'Due when finished', pct: 100, amount: total }];
  }
  const deposit = ms.length || (q?.deposit_pct ?? 0) > 0 ? schedule[0].amount : 0;
  return { selection: sel, lines, minimumAdjustment, subtotal, taxableBase, tax, total, deposit, balance: total - deposit, schedule };
}

/** The five numbers most screens need. */
export function totals(q, selection) {
  const c = computeQuote(q, selection);
  return { subtotal: c.subtotal, tax: c.tax, total: c.total, deposit: c.deposit, balance: c.balance };
}

/** Contractor-only: how much the included lines cost you and what you keep. Lines with no cost entered are ignored. */
export function profitOf(q, selection) {
  const c = computeQuote(q, selection);
  let revenue = 0, cost = 0;
  for (const l of c.lines) {
    if (!l.included || l.cost_cents == null || !['item', 'labor', 'allowance'].includes(l.kind)) continue;
    revenue += l.amount; cost += Math.round(Number(l.qty) * l.cost_cents);
  }
  const margin = revenue - cost;
  return { revenue, cost, margin, pct: revenue > 0 ? Math.round((margin / revenue) * 1000) / 10 : 0, known: cost > 0 };
}

/** What the customer's page may see: everything that affects their price, nothing about your costs or markup. */
export function publicQuote(q) {
  if (!q) return q;
  const out = {
    sent_at: q.sent_at ?? null, valid_until: q.valid_until ?? null, notes: q.notes ?? null, scope: q.scope ?? null,
    exclusions: q.exclusions ?? null, tax_bps: q.tax_bps ?? 0, deposit_pct: q.deposit_pct ?? 0, milestones: q.milestones ?? null,
    min_charge_cents: q.min_charge_cents ?? 0, show_unit_prices: q.show_unit_prices !== false, packages: q.packages ?? null,
    items: (q.items ?? []).map((it) => ({
      id: it.id, name: it.name, unit: it.unit, qty: it.qty, unit_price_cents: it.unit_price_cents, kind: it.kind || 'item',
      optional: !!it.optional, group: it.group ?? null, note: it.note ?? null, ...(it.taxable === false ? { taxable: false } : {}),
    })),
  };
  return out;
}

const squash = (v) => String(v ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ').replace(/[ \t]+/g, ' ').trim();
const text = (v, max) => {
  if (v == null || v === '') return null;
  const s = String(v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  return s ? s.slice(0, max + 1) : null;
};
const fail = (field, error) => ({ ok: false, field, error });
const centsOk = (n, max = 100_000_000) => Number.isInteger(n) && n >= 0 && n <= max;

/** -> { ok: true, value } | { ok: false, field, error }.  Drops unknown keys; never trusts numbers from outside. */
export function validateQuote(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return fail('quote', 'Quote must be an object.');
  if (typeof raw.token !== 'string' || !/^[A-Za-z0-9_-]{20,64}$/.test(raw.token)) return fail('token', 'Quote link id is missing.');
  if (!Array.isArray(raw.items) || raw.items.length < 1) return fail('items', 'Add at least one line to the quote.');
  if (raw.items.length > 80) return fail('items', 'A quote can have up to 80 lines.');

  // packages (Good / Better / Best): 2 or 3 named choices
  let packages = null;
  if (raw.packages != null && !(Array.isArray(raw.packages) && raw.packages.length === 0)) {
    if (!Array.isArray(raw.packages) || raw.packages.length < 2 || raw.packages.length > 3) return fail('packages', 'Offer two or three packages.');
    packages = [];
    for (const p of raw.packages) {
      const key = String(p?.key ?? '');
      const name = squash(p?.name);
      if (!/^[a-z0-9_-]{1,12}$/.test(key) || packages.some((x) => x.key === key)) return fail('packages', 'Each package needs its own short id.');
      if (!name || name.length > 30) return fail('packages', 'Give each package a name (up to 30 characters).');
      packages.push({ key, name, blurb: text(p?.blurb, 120) });
    }
  }

  const items = [];
  const seen = new Set();
  for (const [i, it] of raw.items.entries()) {
    const n = i + 1;
    const kind = it?.kind == null || it.kind === '' ? 'item' : String(it.kind);
    if (!KINDS.includes(kind)) return fail('items', `Line ${n}: unknown line type.`);
    const name = squash(it?.name), unit = squash(it?.unit || (kind === 'surcharge' ? '%' : 'each'));
    const qty = Number(it?.qty);
    const price = kind === 'surcharge' ? 0 : Number(it?.unit_price_cents);
    if (!name || name.length > 120) return fail('items', `Line ${n}: enter a description (up to 120 characters).`);
    if (!unit || unit.length > 20) return fail('items', `Line ${n}: unit is too long.`);
    const maxQty = kind === 'surcharge' ? 500 : 1_000_000;
    if (!Number.isFinite(qty) || qty <= 0 || qty > maxQty || Math.abs(Math.round(qty * 100) / 100 - qty) > 1e-9) {
      return fail('items', kind === 'surcharge' ? `Line ${n}: enter the percent (more than 0).` : `Line ${n}: quantity must be more than 0 (up to 2 decimals).`);
    }
    if (!centsOk(price)) return fail('items', `Line ${n}: price must be $0 or more.`);
    let cost = null;
    if (it?.cost_cents != null && it.cost_cents !== '') {
      cost = Number(it.cost_cents);
      if (!centsOk(cost)) return fail('items', `Line ${n}: your cost must be $0 or more.`);
    }
    let id = it?.id == null || it.id === '' ? `l${n}` : String(it.id);
    if (!/^[A-Za-z0-9_-]{1,16}$/.test(id) || seen.has(id)) id = `l${n}`;
    while (seen.has(id)) id += 'x';
    seen.add(id);
    const optional = !!it?.optional;
    const group = it?.group == null || it.group === '' ? null : String(it.group);
    if (group) {
      if (!packages || !packages.some((p) => p.key === group)) return fail('items', `Line ${n}: it belongs to a package that is not on this quote.`);
      if (optional) return fail('items', `Line ${n}: a line is either an option or part of a package, not both.`);
    }
    const item = { id, name, unit, qty: Math.round(qty * 100) / 100, unit_price_cents: price };
    if (kind !== 'item') item.kind = kind;
    if (optional) item.optional = true;
    if (group) item.group = group;
    const note = text(it?.note, 200);
    if (note) item.note = note.slice(0, 200);
    if (cost != null && kind !== 'surcharge') item.cost_cents = cost;
    if (it?.taxable === false) item.taxable = false;
    items.push(item);
  }

  const tax = raw.tax_bps ?? 0;
  if (!Number.isInteger(tax) || tax < 0 || tax > 2500) return fail('tax_bps', 'Tax rate must be between 0% and 25%.');

  // payments: a single deposit, or up to 6 milestones that add up to 100%
  let milestones = null;
  let dep = raw.deposit_pct ?? 0;
  if (Array.isArray(raw.milestones) && raw.milestones.length) {
    if (raw.milestones.length > 6) return fail('milestones', 'Use up to 6 payment steps.');
    milestones = [];
    for (const m of raw.milestones) {
      const label = squash(m?.label), pct = Number(m?.pct);
      if (!label || label.length > 40) return fail('milestones', 'Name each payment step (up to 40 characters).');
      if (!Number.isInteger(pct) || pct < 1 || pct > 100) return fail('milestones', 'Each payment step must be between 1% and 100%.');
      milestones.push({ label, pct });
    }
    if (milestones.reduce((n, m) => n + m.pct, 0) !== 100) return fail('milestones', 'Payment steps must add up to exactly 100%.');
    dep = milestones[0].pct;
  } else if (!Number.isInteger(dep) || dep < 0 || dep > 100) return fail('deposit_pct', 'Deposit must be between 0% and 100%.');

  const min = raw.min_charge_cents ?? 0;
  if (!centsOk(min)) return fail('min_charge_cents', 'Minimum charge must be $0 or more.');

  let valid = null;
  if (raw.valid_until != null && raw.valid_until !== '') {
    if (typeof raw.valid_until !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw.valid_until) || new Date(`${raw.valid_until}T00:00:00Z`).toISOString().slice(0, 10) !== raw.valid_until) return fail('valid_until', 'Pick a valid "good until" date.');
    valid = raw.valid_until;
  }
  const notes = text(raw.notes, 2000), scope = text(raw.scope, 4000), exclusions = text(raw.exclusions, 2000), internal = text(raw.internal_notes, 2000);
  if (notes && notes.length > 2000) return fail('notes', 'Notes are too long (max 2000 characters).');
  if (scope && scope.length > 4000) return fail('scope', 'The scope of work is too long (max 4000 characters).');
  if (exclusions && exclusions.length > 2000) return fail('exclusions', 'Exclusions are too long (max 2000 characters).');
  if (internal && internal.length > 2000) return fail('internal_notes', 'Private notes are too long (max 2000 characters).');
  let sent = null;
  if (raw.sent_at != null) { const d = new Date(raw.sent_at); if (Number.isNaN(d.getTime())) return fail('sent_at', 'Bad sent time.'); sent = d.toISOString(); }

  const value = { token: raw.token, items, tax_bps: tax, deposit_pct: dep, valid_until: valid, notes, sent_at: sent };
  if (milestones) value.milestones = milestones;
  if (min > 0) value.min_charge_cents = min;
  if (packages) value.packages = packages;
  if (scope) value.scope = scope;
  if (exclusions) value.exclusions = exclusions;
  if (internal) value.internal_notes = internal;
  if (raw.show_unit_prices === false) value.show_unit_prices = false;
  if (!items.some((it) => !it.optional)) return fail('items', 'Add at least one line that is not an optional extra.');
  return { ok: true, value };
}
