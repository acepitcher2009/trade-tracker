// Change a business PIN: npm run set-pin -- <slug>   (PIN typed hidden; never printed)
import { getPool, fail } from './lib/db.js';
import { hashPin } from '../shared/pin.js';
import { askSecret } from './lib/prompt.js';

try {
  const slug = process.argv[2];
  if (!slug) throw new Error('Usage: npm run set-pin -- <business-slug>');
  const pin = await askSecret('New PIN (6-8 digits, hidden): ', 'NEW_PIN');
  const pool = getPool();
  try {
    const r = await pool.query('update businesses set pin_hash = $1 where slug = $2 returning id', [hashPin(pin), slug]);
    if (!r.rowCount) throw new Error(`No business with slug "${slug}".`);
    // Invalidate existing sessions for that business.
    await pool.query('delete from sessions where business_id = $1', [r.rows[0].id]);
    console.log(`PIN updated for "${slug}"; existing sessions signed out.`);
  } finally { await pool.end(); }
} catch (e) { fail(e); }
