// Applies db/migrations/*.sql in order, once each, each in its own transaction.
import { readdirSync, readFileSync } from 'node:fs';
import { getPool, fail } from './lib/db.js';

const dir = new URL('../db/migrations/', import.meta.url);
const pool = getPool();
const client = await pool.connect().catch(fail);
try {
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
  console.log(applied ? `Done: ${applied} migration(s) applied.` : 'Up to date: nothing to apply.');
} catch (e) { fail(e); } finally { client.release(); await pool.end(); }
