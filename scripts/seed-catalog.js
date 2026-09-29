// Give an existing business its trade's SAMPLE price list + sample tax rate (only fills what is missing).
// Usage: npm run seed-catalog -- <slug>      Owners then set their real prices in the app's Price list.
import { getPool, fail } from './lib/db.js';
import { assertTarget } from './lib/guard.js';
import { getPreset } from '../db/presets.js';
import { seedCatalog } from './lib/tenant.js';

try {
  const slug = process.argv[2];
  if (!slug) throw new Error('Usage: npm run seed-catalog -- <business-slug>');
  const pool = getPool();
  await assertTarget(pool);
  try {
    const { rows: [b] } = await pool.query('select id, preset, tax_rate_bps from businesses where slug = $1', [slug]);
    if (!b) throw new Error(`No business with slug "${slug}".`);
    const preset = getPreset(b.preset);
    const n = await seedCatalog(pool, b.id, preset);
    if (!b.tax_rate_bps && preset.taxBps) await pool.query('update businesses set tax_rate_bps = $2 where id = $1', [b.id, preset.taxBps]);
    console.log(`Added ${n} sample price-list item(s) to "${slug}".`);
  } finally { await pool.end(); }
} catch (e) { fail(e); }
