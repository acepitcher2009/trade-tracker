// Install invitations (public endpoints: the token itself is the credential, 192 random bits, hash-stored).
import { createHash } from 'node:crypto';
import { query } from './db.js';
import { HttpError, json } from './http.js';

export const hashToken = (t) => createHash('sha256').update(t).digest('hex');
const TOKEN = /^[A-Za-z0-9_-]{20,64}$/;
const okToken = (t) => typeof t === 'string' && TOKEN.test(t);

/** The live (unexpired, unused) invite for a token, with its business, or null. */
async function live(token) {
  if (!okToken(token)) return null;
  const [r] = await query(
    `select i.id, i.kind, b.slug, b.name, b.accent_color, b.preset
       from invites i join businesses b on b.id = i.business_id
      where i.token_hash = $1 and i.consumed_at is null and i.expires_at > now()`, [hashToken(token)]);
  return r ?? null;
}

export async function inviteGet(token) {
  const r = await live(token);
  // Same answer for unknown, expired and used tokens, so nothing can be learned by guessing.
  if (!r) return json({ valid: false });
  return json({ valid: true, kind: r.kind, business: { name: r.name, accent_color: r.accent_color, preset: r.preset } });
}

/** Called by the INSTALLED app on its first launch. Uses up an install invite; browser invites are left alone. */
export async function inviteConsume(token) {
  if (!okToken(token)) return json({ consumed: false });
  const [r] = await query(
    `with used as (
       update invites set consumed_at = now()
        where token_hash = $1 and kind = 'install' and consumed_at is null and expires_at > now()
        returning business_id)
     select b.slug, b.name, b.preset from used join businesses b on b.id = used.business_id`, [hashToken(token)]);
  return r ? json({ consumed: true, slug: r.slug, name: r.name, preset: r.preset }) : json({ consumed: false });
}

/** A per-business web manifest whose start_url carries the token, so the installed app can report back. */
export async function inviteManifest(token) {
  const r = await live(token);
  if (!r) throw new HttpError(404, 'Not found');
  const dir = '/icons'; // one app icon for every trade; only the sign-in background changes
  const body = {
    name: r.name, short_name: r.name.slice(0, 12), description: `${r.name} client and job tracker`,
    start_url: `/?i=${token}`, scope: '/', display: 'standalone', orientation: 'portrait',
    background_color: '#f3f4f6', theme_color: r.accent_color,
    icons: [
      { src: `${dir}/icon-192.png`, sizes: '192x192', type: 'image/png' },
      { src: `${dir}/icon-512.png`, sizes: '512x512', type: 'image/png' },
      { src: `${dir}/icon-maskable-512.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/manifest+json; charset=utf-8', 'cache-control': 'no-store' } });
}
