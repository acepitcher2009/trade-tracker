import { neon } from '@neondatabase/serverless';

let _sql;
/** Parameterized query over Neon's HTTP driver. Always pass values via `params`, never string-concat. */
export function query(text, params = []) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  _sql ??= neon(url);
  return _sql.query(text, params);
}
