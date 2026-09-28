import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import Login from './screens/Login.jsx';
import Lookup from './screens/Lookup.jsx';
import QuickAdd from './screens/QuickAdd.jsx';
import StatusPill from './components/StatusPill.jsx';

export default function App() {
  const [me, setMe] = useState(undefined); // undefined = loading, null = signed out
  const [screen, setScreen] = useState({ name: 'lookup', q: '' });
  const [toast, setToast] = useState('');

  const loadMe = useCallback(() => api.me().then(setMe).catch(() => setMe(null)), []);
  useEffect(() => { loadMe(); }, [loadMe]);

  // Tenant theming: CSS variables driven by the business config.
  useEffect(() => {
    const b = me?.business;
    document.documentElement.style.setProperty('--accent', b?.accent_color || '#111827');
    document.title = b?.name ? `${b.name} — Trade Tracker` : 'Trade Tracker';
  }, [me]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  const expired = useCallback(() => { setMe(null); setScreen({ name: 'lookup', q: '' }); }, []);
  const signOut = async () => { try { await api.logout(); } catch { /* ignore */ } expired(); };

  if (me === undefined) return <div className="boot" aria-busy="true">Loading…</div>;
  if (me === null) return <Login onDone={loadMe} />;

  const terms = me.business.terms || {};
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">{me.business.name}</div>
        <StatusPill />
        <button className="link" onClick={signOut}>Sign out</button>
      </header>
      <main>
        {screen.name === 'lookup' && (
          <Lookup me={me} terms={terms} initialQ={screen.q}
            onAdd={(phone) => setScreen({ name: 'add', phone })} onExpired={expired} />
        )}
        {screen.name === 'add' && (
          <QuickAdd me={me} terms={terms} phone={screen.phone} onExpired={expired}
            onCancel={() => setScreen({ name: 'lookup', q: screen.phone })}
            onSaved={(client, created) => {
              setToast(created ? `${terms.client || 'Client'} saved` : `Already a ${(terms.client || 'client').toLowerCase()} — showing their record`);
              setScreen({ name: 'lookup', q: client.phone_digits });
            }} />
        )}
      </main>
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}
