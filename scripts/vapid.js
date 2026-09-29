// One-time: makes the key pair that lets the server send "quote accepted" alerts.
// Writes VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY to your local .env (never printed) and shows the public key only.
// Then add the SAME two variables to Netlify (Site settings > Environment variables) for the live site.
import { generateKeyPairSync } from 'node:crypto';
import { appendFileSync, readFileSync, existsSync } from 'node:fs';

const envPath = new URL('../.env', import.meta.url);
const current = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
if (/^VAPID_PRIVATE_KEY=/m.test(current)) {
  console.log('VAPID keys are already in .env — nothing changed. (Delete those two lines first if you want new ones; every phone would then need to turn alerts on again.)');
  process.exit(0);
}
const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const pub = publicKey.export({ format: 'jwk' }), prv = privateKey.export({ format: 'jwk' });
const point = Buffer.concat([Buffer.from([4]), Buffer.from(pub.x, 'base64url'), Buffer.from(pub.y, 'base64url')]).toString('base64url');
appendFileSync(envPath, `${current && !current.endsWith('\n') ? '\n' : ''}\n# Alerts when a customer accepts a quote (made by npm run vapid). Keep the private key secret.\nVAPID_PUBLIC_KEY=${point}\nVAPID_PRIVATE_KEY=${prv.d}\n`);
console.log('Saved VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY to .env (the private key is not shown).');
console.log('Add both variables to Netlify too, copying them from .env.');
