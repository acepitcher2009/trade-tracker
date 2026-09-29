// Safety rails for scripts and tests. Which database is this? The DEV branch carries a marker row
// (tt_env: branch = 'dev'); production never does. Nothing here prints the connection string.
import { getPool } from './db.js';

export async function branchName(pool) {
  try {
    const { rows } = await pool.query("select value from tt_env where key = 'branch'");
    return rows[0]?.value ?? 'unmarked';
  } catch { return 'unmarked'; } // table missing (migration 011 not applied yet)
}

/** Tests and demo seeding may only touch the dev branch. */
export async function assertDev(pool = getPool()) {
  const b = await branchName(pool);
  if (b !== 'dev') {
    console.error(`\nRefusing to run: this database is not marked as the dev branch (found: ${b}).\n` +
      'Tests and demo data only run on dev. Point DATABASE_URL at the dev branch and run `npm run migrate` there once.\n');
    process.exit(2);
  }
}

/** Setup scripts (migrate, onboard, seed, invite, set-pin) also work on production, but only when asked for explicitly. */
export async function assertTarget(pool, argv = process.argv) {
  const b = await branchName(pool);
  const ok = b === 'dev' || argv.includes('--production') || process.env.ALLOW_PRODUCTION === '1';
  if (!ok) {
    console.error('\nRefusing to run: this is NOT the dev branch, so it may be your live data.\n' +
      'If you really mean to change production, run it again with --production (or ALLOW_PRODUCTION=1).\n');
    process.exit(2);
  }
  return b;
}
