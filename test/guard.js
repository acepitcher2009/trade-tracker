// Imported first by every DB test: refuses to run unless DATABASE_URL is the dev branch.
import '../scripts/lib/env.js';
import { getPool } from '../scripts/lib/db.js';
import { assertDev } from '../scripts/lib/guard.js';

if (process.env.DATABASE_URL) {
  const pool = getPool();
  try { await assertDev(pool); } finally { await pool.end(); }
}
