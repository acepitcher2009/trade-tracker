import { getPreset } from '../../db/presets.js';
import { hashPin } from '../../shared/pin.js';
import { normalizePhone } from '../../shared/phone.js';

export function slugify(s) {
  return String(s).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Create a business + its preset job types and statuses in ONE transaction.
 * Returns { id, slug } or throws (slug already taken, bad input, ...).
 */
export async function createBusiness(pool, { name, slug, phone, city, state, preset, accent, pin }) {
  const p = getPreset(preset);
  const phoneDigits = phone ? normalizePhone(phone) : null;
  if (phone && !phoneDigits) throw new Error('Business phone must be a valid 10-digit US number.');
  const finalSlug = slug || slugify(name);
  if (!name?.trim()) throw new Error('Business name is required.');
  const pinHash = hashPin(pin); // validates 6-8 digits

  const client = await pool.connect();
  try {
    await client.query('begin');
    const { rows } = await client.query(
      `insert into businesses (slug, name, phone_digits, city, state, preset, accent_color, terms, pin_hash)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id, slug`,
      [finalSlug, name.trim(), phoneDigits, city || null, state || null, preset,
       accent || p.accent, JSON.stringify(p.terms), pinHash]
    );
    const biz = rows[0];
    for (const [i, t] of p.jobTypes.entries()) {
      await client.query(
        'insert into job_types (business_id, name, sort_order) values ($1,$2,$3)', [biz.id, t, i]);
    }
    for (const [i, s] of p.statuses.entries()) {
      await client.query(
        'insert into statuses (business_id, key, label, sort_order, color) values ($1,$2,$3,$4,$5)',
        [biz.id, s.key, s.label, i, s.color]);
    }
    await client.query(
      'update businesses set tax_rate_bps = $2, min_charge_cents = $3, uses_visits = $4, default_deposit_pct = $5 where id = $1',
      [biz.id, p.taxBps ?? 0, Math.round((p.minChargeDollars ?? 0) * 100), p.usesVisits !== false, p.depositPct ?? 50]);
    await seedCatalog(client, biz.id, p);
    await client.query('commit');
    return biz;
  } catch (e) {
    await client.query('rollback').catch(() => {});
    if (e.code === '23505') throw new Error(`A business with slug "${finalSlug}" already exists.`);
    throw e;
  } finally {
    client.release();
  }
}

/** Copy a preset's sample price list into a business (skips items that already exist by name). */
export async function seedCatalog(db, businessId, preset) {
  const types = new Map((await db.query('select id, name from job_types where business_id = $1', [businessId])).rows.map((r) => [r.name, r.id]));
  let n = 0;
  for (const [i, [name, unit, dollars, typeName, kind = 'item']] of (preset.catalog ?? []).entries()) {
    const r = await db.query(
      `insert into catalog_items (business_id, name, unit, unit_price_cents, job_type_id, sort_order, kind)
       select $1, $2, $3, $4, $5, $6, $7
        where not exists (select 1 from catalog_items where business_id = $1 and name = $2)`,
      [businessId, name, unit, Math.round(dollars * 100), types.get(typeName) ?? null, i, kind]);
    n += r.rowCount;
  }
  return n;
}
