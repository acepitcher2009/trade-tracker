// Applies db/migrations/*.sql in order, once each, each in its own transaction.
import { readdirSync, readFileSync } from 'node:fs';
import { getPool, fail } from './lib/db.js';
import { branchName } from './lib/guard.js';

const dir = new URL('../db/migrations/', import.meta.url);
const pool = getPool();
const client = await pool.connect().catch(fail);
try {
  // Which database is this? Marked dev -> fine. Unmarked -> you must say what it is (--dev marks it as the dev branch).
  const branch = await branchName(client);
  const wantsDev = process.argv.includes('--dev'), wantsProd = process.argv.includes('--production') || process.env.ALLOW_PRODUCTION === '1';
  if (branch !== 'dev' && !wantsProd && !wantsDev) {
    console.error('\nRefusing to run: this database is not marked as the dev branch, so it may be your live data.\n' +
      '  dev branch:  npm run migrate -- --dev     (also marks it as dev so tests may run there)\n' +
      '  production:  npm run migrate -- --production\n');
    process.exit(2);
  }
  if (wantsDev && wantsProd) throw new Error('Pick one of --dev or --production.');
  await client.query(`create table if not exists schema_migrations (
    name text primary key, applied_at timestamptz not null default now())`);
  const done = new Set((await client.query('select name from schema_migrations')).rows.map(r => r.name));
  const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  let applied = 0;
  for (const f of files) {
    if (done.has(f)) continue;
    await client.query('begin');
    try {
      await client.query(readFileSync(new URL(f, dir), 'utf8'));
      await client.query('insert into schema_migrations (name) values ($1)', [f]);
      await client.query('commit');
      console.log(`applied ${f}`); applied++;
    } catch (e) { await client.query('rollback'); throw e; }
  }
  if (wantsDev) { await client.query("insert into tt_env (key, value) values ('branch', 'dev') on conflict (key) do update set value = 'dev'"); console.log('Marked this database as the dev branch.'); }
  console.log(applied ? `Done: ${applied} migration(s) applied.` : 'Up to date: nothing to apply.');
} catch (e) { fail(e); } finally { client.release(); await pool.end(); }
