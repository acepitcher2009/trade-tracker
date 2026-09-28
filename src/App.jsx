import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { createData, readCachedConfig, wipeDatabase } from './data.js';
import { useSnap } from './useSnap.js';
import Login from './screens/Login.jsx';
import Lookup from './screens/Lookup.jsx';
import QuickAdd from './screens/QuickAdd.jsx';
import ClientCard from './screens/ClientCard.jsx';
import StatusPill from './components/StatusPill.jsx';
import SyncSheet from './components/SyncSheet.jsx';

const lsGet = (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };

export default function App() {
  const [phase, setPhase] = useState('loading'); // loading | login | ready | needs-connection
  const [data, setData] = useState(null);
  const current = useRef(null);

  const open = useCallback(async (cfg) => {
    const slug = cfg.business.slug;
    lsSet('tt_slug', slug);
    const d = createData(slug);
    await d.init(cfg);
    d.start();
    current.current = { d, slug };
    setData(d); setPhase('ready');
  }, []);

  const boot = useCallback(async () => {
    setPhase('loading');
    try {
      await open(await api.me());
    } catch (e) {
      if (e.status === 401) return setPhase('login');
      if (e.status === 0) { // no signal: run from the copy on this phone
        const slug = lsGet('tt_slug');
        const cached = slug && await readCachedConfig(slug).catch(() => null);
        if (cached) return open(cached);
        return setPhase('needs-connection');
      }
      setPhase('login');
    }
  }, [open]);

  useEffect(() => { boot(); }, [boot]);

  const closeCurrent = async () => { await current.current?.d.close(); current.current = null; setData(null); };
  const onAuthExpired = useCallback(async () => { await closeCurrent(); setPhase('login'); }, []);
  const onSignOut = async () => {
    const { d, slug } = current.current;
    const pending = d.getSnapshot().pending;
    if (pending && !window.confirm(`${pending} change${pending === 1 ? '' : 's'} on this phone haven't synced yet and will be lost if you sign out. Sign out anyway?`)) return;
    try { await api.logout(); } catch { window.alert('Signing out needs a connection. Try again when you have signal.'); return; }
    await closeCurrent();
    await wipeDatabase(slug).catch(() => {});
    setPhase('login');
  };

  if (phase === 'loading') return <div className="boot" aria-busy="true">Loading…</div>;
  if (phase === 'login') return <Login onDone={boot} />;
  if (phase === 'needs-connection') {
    return (
      <div className="login">
        <h1>Trade Tracker</h1>
        <p className="hint">You need a connection to sign in the first time on this phone.</p>
        <button className="btn btn-primary" onClick={boot}>Try again</button>
      </div>
    );
  }
  return <Shell data={data} onSignOut={onSignOut} onAuthExpired={onAuthExpired} />;
}

function Shell({ data, onSignOut, onAuthExpired }) {
  const snap = useSnap(data);
  const cfg = data.getConfig();
  const terms = cfg.business.terms || {};
  const [screen, setScreen] = useState({ name: 'lookup', q: '' });
  const [toast, setToast] = useState('');
  const [sheet, setSheet] = useState(false);

  useEffect(() => { if (snap.authExpired) onAuthExpired(); }, [snap.authExpired, onAuthExpired]);

  // Tenant theming: CSS variables + home-screen label driven by the business config.
  useEffect(() => {
    document.documentElement.style.setProperty('--accent', cfg.business.accent_color || '#111827');
    document.title = `${cfg.business.name} — Trade Tracker`;
    let m = document.querySelector('meta[name="apple-mobile-web-app-title"]');
    if (!m) { m = document.createElement('meta'); m.name = 'apple-mobile-web-app-title'; document.head.appendChild(m); }
    m.content = cfg.business.name;
  }, [cfg.business.accent_color, cfg.business.name]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const noun = terms.client || 'Client';
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">{cfg.business.name}</div>
        <button className="link" onClick={onSignOut}>Sign out</button>
      </header>
      <StatusPill snap={snap} onClick={() => setSheet(true)} />
      <main>
        {screen.name === 'lookup' && (
          <Lookup data={data} snap={snap} terms={terms} initialQ={screen.q}
            onAdd={(phone) => setScreen({ name: 'add', phone })}
            onOpen={(c) => setScreen({ name: 'client', id: c.id, phone: c.phone_digits })} />
        )}
        {screen.name === 'add' && (
          <QuickAdd data={data} cfg={cfg} terms={terms} phone={screen.phone}
            onCancel={() => setScreen({ name: 'lookup', q: screen.phone })}
            onSaved={(client, created) => {
              const offline = !data.getSnapshot().reachable;
              setToast(!created ? `Already a ${noun.toLowerCase()} — showing their record`
                : offline ? `${noun} saved on this phone — will sync when you have signal` : `${noun} saved`);
              setScreen({ name: 'lookup', q: client.phone_digits });
            }} />
        )}
        {screen.name === 'client' && (
          <ClientCard data={data} snap={snap} cfg={cfg} terms={terms} id={screen.id}
            onBack={() => setScreen({ name: 'lookup', q: screen.phone })} />
        )}
      </main>
      {toast && <div className="toast" role="status">{toast}</div>}
      {sheet && <SyncSheet data={data} snap={snap} onClose={() => setSheet(false)} />}
    </div>
  );
}
