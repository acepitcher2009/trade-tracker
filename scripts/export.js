// Export one business's own data: npm run export -- <slug> [--format csv|json] [--out path]
// Files land in ./exports/ by default (git-ignored: they contain customer phone numbers).
import { parseArgs } from 'node:util';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { query } from '../server/db.js';
import { loadExport, toCsv } from '../server/export.js';
import './lib/env.js';
import { fail } from './lib/db.js';

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { format: { type: 'string', default: 'csv' }, out: { type: 'string' } } });
  const slug = positionals[0];
  if (!slug) throw new Error('Usage: npm run export -- <business-slug> [--format csv|json] [--out file]');
  if (!['csv', 'json'].includes(values.format)) throw new Error('--format must be csv or json');
  const [biz] = await query('select id from businesses where slug = $1', [slug]);
  if (!biz) throw new Error(`No business with slug "${slug}".`);
  const data = await loadExport(biz.id);
  const out = values.out ?? `exports/${slug}-${data.exported_at.slice(0, 10)}.${values.format}`;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, values.format === 'csv' ? toCsv(data) : JSON.stringify(data, null, 2));
  console.log(`Exported ${data.clients.length} clients and ${data.clients.reduce((n, c) => n + c.jobs.length, 0)} jobs to ${out}`);
} catch (e) { fail(e); }
