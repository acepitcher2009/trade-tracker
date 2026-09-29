// Onboard a new business: npm run onboard
// Interactive, or pass flags:  npm run onboard -- --name "Acme Roofing" --preset roofing \
//   --phone "(979) 555-0100" --city Bryan --state TX [--slug acme-roofing] [--accent "#b91c1c"]
// The PIN is typed hidden (or set ONBOARD_PIN when there is no terminal). It is never printed.
import { parseArgs } from 'node:util';
import { PRESETS } from '../db/presets.js';
import { getPool, fail } from './lib/db.js';
import { assertTarget } from './lib/guard.js';
import { createBusiness, slugify } from './lib/tenant.js';
import { ask, askSecret } from './lib/prompt.js';

try {
  const { values: a } = parseArgs({ options: {
    name: { type: 'string' }, slug: { type: 'string' }, phone: { type: 'string' },
    city: { type: 'string' }, state: { type: 'string' }, preset: { type: 'string' },
    accent: { type: 'string' },
  }});
  const tty = process.stdin.isTTY;
  const presets = Object.keys(PRESETS);

  const name   = a.name   ?? (tty ? await ask('Business name') : '');
  const preset = a.preset ?? (tty ? await ask(`Preset (${presets.join(', ')})`, 'fence') : '');
  const phone  = a.phone  ?? (tty ? await ask('Business phone') : '');
  const city   = a.city   ?? (tty ? await ask('City') : '');
  const state  = a.state  ?? (tty ? await ask('State', 'TX') : '');
  const slug   = a.slug   ?? (tty ? await ask('Login slug', slugify(name)) : slugify(name));
  const pin    = await askSecret('PIN (6-8 digits, hidden): ', 'ONBOARD_PIN');
  if (tty) {
    const again = await askSecret('Repeat PIN: ');
    if (again !== pin) throw new Error('PINs did not match.');
  }

  const pool = getPool();
  await assertTarget(pool);
  try {
    const biz = await createBusiness(pool, { name, slug, phone, city, state, preset, accent: a.accent, pin });
    console.log(`\nCreated "${name}" (login slug: ${biz.slug}, preset: ${preset}).`);
    console.log('They sign in with that slug + the PIN you just set.');
  } finally { await pool.end(); }
} catch (e) { fail(e); }
