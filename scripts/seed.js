// Seeds the first tenant: Deno Fence and Stain. Idempotent: skips if it already exists.
// Needs DENO_PIN (6-8 digits) in .env or the environment the first time only.
import { getPool, fail } from './lib/db.js';
import { assertTarget } from './lib/guard.js';
import { createBusiness } from './lib/tenant.js';

const SLUG = 'deno-fence-and-stain';
const pool = getPool();
await assertTarget(pool);
try {
  const { rows } = await pool.query('select id from businesses where slug = $1', [SLUG]);
  if (rows.length) {
    console.log(`"${SLUG}" already exists — nothing to do. (Change its PIN with: npm run set-pin -- ${SLUG})`);
  } else {
    if (!process.env.DENO_PIN) throw new Error('Set DENO_PIN (6-8 digits) in .env before seeding. It is never printed.');
    const biz = await createBusiness(pool, {
      name: 'Deno Fence and Stain', slug: SLUG, phone: '(979) 492-1302',
      city: 'Bryan', state: 'TX', preset: 'fence', pin: process.env.DENO_PIN,
    });
    console.log(`Created business "${biz.slug}" with the fence preset.`);
  }
} catch (e) { fail(e); } finally { await pool.end(); }
