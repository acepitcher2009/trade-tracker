// "A customer accepted your quote" alerts on this phone (Web Push). Works in the installed app (iPhone needs iOS 16.4+).
import { api } from './api.js';

export const pushSupported = () => typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

// A phone that never answers must not leave the settings screen waiting forever.
const within = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('The phone did not answer. Try again.')), ms))]);

const keyBytes = (b64u) => {
  const pad = '='.repeat((4 - (b64u.length % 4)) % 4);
  const raw = atob((b64u + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

/** 'unsupported' | 'unavailable' (server has no keys) | 'blocked' | 'on' | 'off' */
export async function pushState() {
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';
  try {
    const reg = await within(navigator.serviceWorker.getRegistration(), 2500);
    const sub = await within(reg?.pushManager.getSubscription() ?? Promise.resolve(null), 2500);
    if (sub && Notification.permission === 'granted') return 'on';
  } catch { /* fall through */ }
  try { await api.pushKey(); } catch (e) { return e.status === 404 ? 'unavailable' : 'off'; }
  return 'off';
}

export async function enablePush() {
  const { key } = await api.pushKey();
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Alerts were not allowed. You can allow them in your phone’s settings for this app.');
  const reg = await within(navigator.serviceWorker.ready, 6000);
  const sub = (await reg.pushManager.getSubscription()) ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
  await api.pushSubscribe(sub.endpoint);
}

export async function disablePush() {
  const reg = await within(navigator.serviceWorker.getRegistration(), 3000);
  const sub = await reg?.pushManager.getSubscription();
  if (sub) { await api.pushUnsubscribe(sub.endpoint).catch(() => {}); await sub.unsubscribe().catch(() => {}); }
}
