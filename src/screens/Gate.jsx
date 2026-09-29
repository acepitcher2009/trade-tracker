import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { applyTrade } from '../theme.js';
import { inviteToken, isStandalone, stripToken } from '../install.js';
import InstallTip from '../components/InstallTip.jsx';
import Login from './Login.jsx';

const setSlug = (v) => { try { localStorage.setItem('tt_slug', v); } catch { /* ignore */ } };

/**
 * Decides what a signed-out visitor sees:
 *   installed app          -> sign-in (and, on first launch, reports back so the install link is used up)
 *   browser + install link -> install instructions only (no sign-in fields)
 *   browser + owner override link -> sign-in
 *   browser, no/used/expired link -> a "get a link" message
 * This is an onboarding flow, not the security boundary: the PIN, rate limiting and server sessions still guard the data.
 */
export default function Gate({ onDone }) {
  const token = inviteToken();
  const standalone = isStandalone();
  const showLogin = import.meta.env.DEV || standalone; // dev builds always sign in (no https/install on a LAN phone)
  const [view, setView] = useState(showLogin ? (standalone && token ? 'checking' : 'login') : token ? 'checking' : 'locked');
  const [biz, setBiz] = useState(null);

  useEffect(() => {
    let live = true;
    const set = (v) => live && setView(v);
    if (standalone && token) {
      // First launch of the installed app: use up the invite and pre-fill the business ID.
      api.consumeInvite(token).then((r) => { if (r.slug) setSlug(r.slug); if (r.preset) applyTrade(r.preset); }).catch(() => {}).finally(() => { stripToken(); set('login'); });
    } else if (!showLogin && token) {
      api.invite(token).then((r) => {
        if (!r.valid) return set('expired');
        setBiz(r.business);
        applyTrade(r.business.preset);
        set(r.kind === 'browser' ? 'login' : 'install');
      }).catch(() => set('offline'));
    }
    return () => { live = false; };
  }, [standalone, token, showLogin]);

  if (view === 'login') return <Login onDone={onDone} />;
  if (view === 'install') return <InstallPage biz={biz} token={token} />;
  if (view === 'checking') return <main className="boot" aria-busy="true">One moment…</main>;
  return (
    <main className="login">
      <h1>Trade Tracker</h1>
      {view === 'expired' && <p className="error" role="alert">This link has expired or was already used. Ask for a new one.</p>}
      {view === 'offline' && <p className="error" role="alert">Can’t reach the server. Check your signal and reload.</p>}
      {view === 'locked' && (
        <p className="hint">This app is installed from a personal link. Open the link you were sent. If you already installed it, open it from your home screen. Need a link? Ask the person who runs your business account.</p>
      )}
    </main>
  );
}

function InstallPage({ biz, token }) {
  const [deferred, setDeferred] = useState(null);
  const [installed, setInstalled] = useState(false);

  useEffect(() => {
    // Give this install its own name and a start address that carries the invite, so the installed app can report back.
    const link = document.querySelector('link[rel="manifest"]');
    if (link) link.href = `/api/manifest?i=${encodeURIComponent(token)}`;
    document.title = `Install ${biz.name}`;
    if (biz.accent_color) document.documentElement.style.setProperty('--accent', biz.accent_color);
    let m = document.querySelector('meta[name="apple-mobile-web-app-title"]');
    if (!m) { m = document.createElement('meta'); m.name = 'apple-mobile-web-app-title'; document.head.appendChild(m); }
    m.content = biz.name;
    const before = (e) => { e.preventDefault(); setDeferred(e); };
    const done = () => setInstalled(true);
    window.addEventListener('beforeinstallprompt', before);
    window.addEventListener('appinstalled', done);
    return () => { window.removeEventListener('beforeinstallprompt', before); window.removeEventListener('appinstalled', done); };
  }, [biz, token]);

  return (
    <main className="login">
      <h1>Install {biz.name}</h1>
      {installed
        ? <p className="banner banner-existing" role="status">Installed! Close this page and open the app from your home screen. This link stops working once you open it.</p>
        : <p className="hint">Add the app to your phone or tablet, then open it from your home screen to sign in. Sign-in only appears inside the installed app.</p>}
      <InstallTip canPrompt={!!deferred && !installed} onPrompt={async () => { deferred.prompt(); await deferred.userChoice.catch(() => {}); setDeferred(null); }} />
    </main>
  );
}
