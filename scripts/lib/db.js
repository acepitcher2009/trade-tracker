import './env.js';
import { Pool } from '@neondatabase/serverless';

export function getPool() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set (put it in .env — see .env.example).');
  return new Pool({ connectionString: url });
}

/** Print an error without ever leaking DATABASE_URL, then exit non-zero. */
export function fail(err) {
  let msg = err?.message ?? String(err);
  const url = process.env.DATABASE_URL;
  if (url) msg = msg.split(url).join('[DATABASE_URL]');
  console.error(`\nError: ${msg}`);
  process.exit(1);
}
