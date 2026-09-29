// Make an install link for one person:  npm run invite -- <slug> [--browser] [--days N] [--base https://your-site]
//   default            install link, valid 7 days, used up when that person's installed app first opens
//   --browser          owner override: lets them sign in from a browser tab (default 1 day)
// The link is printed once (only a hash is stored). Treat it like a password until it is used.
import { randomBytes } from 'node:crypto';
import { getPool, fail } from './lib/db.js';
import { assertTarget } from './lib/guard.js';
import { hashToken } from '../server/invites.js';

try {
  const args = process.argv.slice(2);
  const slug = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--days' && args[args.indexOf(a) - 1] !== '--base');
  const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  if (!slug) throw new Error('Usage: npm run invite -- <business-slug> [--browser] [--days N] [--base https://site]');
  const browser = args.includes('--browser');
  const days = Number(flag('--days') ?? (browser ? 1 : 7));
  if (!(days > 0 && days <= 60)) throw new Error('--days must be between 1 and 60.');
  const base = (flag('--base') || process.env.SITE_URL || 'http://localhost:5173').replace(/\/+$/, '');

  const token = randomBytes(24).toString('base64url');
  const pool = getPool();
  await assertTarget(pool);
  try {
    const { rows: [biz] } = await pool.query('select id, name from businesses where slug = $1', [slug]);
    if (!biz) throw new Error(`No business with slug "${slug}".`);
    await pool.query(
      `insert into invites (business_id, token_hash, kind, expires_at) values ($1, $2, $3, now() + ($4 || ' days')::interval)`,
      [biz.id, hashToken(token), browser ? 'browser' : 'install', String(days)]);
    console.log(`${browser ? 'Browser sign-in' : 'Install'} link for ${biz.name}, valid ${days} day(s):\n\n  ${base}/?i=${token}\n`);
  } finally { await pool.end(); }
} catch (e) { fail(e); }
