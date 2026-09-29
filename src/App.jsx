import { whenText } from './format.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api.js';
import { createData, readCachedConfig, wipeDatabase } from './data.js';
import { useSnap } from './useSnap.js';
import Gate from './screens/Gate.jsx';
import Board from './screens/Board.jsx';
import QuickAdd from './screens/QuickAdd.jsx';
import ClientCard from './screens/ClientCard.jsx';
import QuoteBuilder from './screens/QuoteBuilder.jsx';
import PriceList from './screens/PriceList.jsx';
import { applyTrade } from './theme.js';
import NavBar from './components/NavBar.jsx';
import ConfirmSheet from './components/ConfirmSheet.jsx';
import StatusPill from './components/StatusPill.jsx';
import SyncSheet from './components/SyncSheet.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import Tour from './tour/Tour.jsx';
import { seedTour } from './tour/sample.js';

const lsGet = (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };

// The tour's sample copy has no server: anything that would call one is refused.
const NO_SERVER = new Proxy({}, { get: () => () => Promise.reject(new ApiError(400, 'That is turned off during the tour.')) });
const tourDb = (slug) => `tt-tour-${slug}`;

export default function App() {
  const [phase, setPhase] = useState('loading'); // loading | login | ready | needs-connection
  const [data, setData] = useState(null);
  const [tour, setTour] = useState(null); // the sample copy while the guided tour is running
  const current = useRef(null);
  const tourRef = useRef(null);
  tourRef.current = tour;
  const starting = useRef(false);

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

  const startTour = useCallback(async () => {
    const cur = current.current;
    if (!cur || tourRef.current || starting.current) return;
    starting.current = true;
    try {
      await wipeDatabase(cur.slug, tourDb(cur.slug)).catch(() => {});
      const d = createData(cur.slug, { api: NO_SERVER, dbName: tourDb(cur.slug), autoSync: false, demo: true });
      const cfg = cur.d.getConfig();
      await d.init(cfg);
      await seedTour(d, cfg);
      setTour(d);
    } catch (e) { lsSet(`tt_tour_${cur.slug}`, '1'); } finally { starting.current = false; } // a tour that will not start must never get in the way
  }, []);
  /** Close the sample copy and delete it, and remember that this phone has seen the tour. */
  const endTour = useCallback(async () => {
    const d = tourRef.current, cur = current.current;
    setTour(null);
    if (cur) lsSet(`tt_tour_${cur.slug}`, '1');
    if (!d || !cur) return;
    try { for (const j of await d.board()) localStorage.removeItem(`tt_qdraft_${j.id}`); } catch { /* ignore */ }
    await d.close().catch(() => {});
    await wipeDatabase(cur.slug, tourDb(cur.slug)).catch(() => {});
  }, []);
  // The first time someone signs in on this phone, the tour starts by itself.
  useEffect(() => {
    if (phase === 'ready' && current.current && !lsGet(`tt_tour_${current.current.slug}`)) startTour();
  }, [phase, data, startTour]);

  const closeCurrent = async () => { await current.current?.d.close(); current.current = null; setData(null); };
  const onAuthExpired = useCallback(async () => { await closeCurrent(); setPhase('login'); }, []);
  const finishSignOut = (slug) => {
    if (tourRef.current) endTour();
    setPhase('login'); // go straight to sign-in; clean up the phone's copy in the background
    closeCurrent().catch(() => {}).finally(() => { wipeDatabase(slug).catch(() => {}); });
  };
  /** Returns { ask } when the person must decide something first (unsynced changes, no signal). */
  const onSignOut = async (force = false) => {
    const { d, slug } = current.current;
    const pending = d.getSnapshot().pending;
    if (pending && !force) return { ask: { kind: 'pending', n: pending } };
    try { await api.logout(); } catch { return { ask: { kind: 'offline' } }; }
    finishSignOut(slug);
    return {};
  };

  if (phase === 'loading') return <main className="boot" aria-busy="true">Loading…</main>;
  if (phase === 'login') return <Gate onDone={boot} />;
  if (phase === 'needs-connection') {
    return (
      <main className="login">
        <h1>Trade Tracker</h1>
        <p className="hint">You need a connection to sign in the first time on this phone.</p>
        <button className="btn btn-primary" onClick={boot}>Try again</button>
      </main>
    );
  }
  return <Shell key={tour ? 'tour' : 'real'} data={tour ?? data} demo={!!tour} onSignOut={onSignOut} onAuthExpired={onAuthExpired} onTourStart={startTour} onTourEnd={endTour} />;
}

function Shell({ data, demo, onSignOut, onAuthExpired, onTourStart, onTourEnd }) {
  const snap = useSnap(data);
  const cfg = data.getConfig();
  const terms = cfg.business.terms || {};
  const [screen, setScreen] = useState({ name: 'board' });
  const [view, setView] = useState({ tab: 'clients', q: '' });
  const home = () => setScreen({ name: 'board' });
  const [toast, setToast] = useState('');
  const [linkNote, setLinkNote] = useState(''); // the quote link, shown if the phone would not let us copy it
  const [sheet, setSheet] = useState(false);
  const [ask, setAsk] = useState(null); // a sign-out question waiting for an answer
  const signOut = async (force) => { const r = await onSignOut(force); setAsk(r?.ask ?? null); };

  useEffect(() => { // hide the bottom tabs while a field is focused so the keyboard doesn't float them over the form
    // A field you can type in. (Read-only boxes, like the quote link, bring up no keyboard.)
    const isField = (el) => el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && !el.readOnly && !['checkbox', 'radio', 'button', 'submit'].includes(el.type);
    // Safari tints the strip above the keyboard with the theme colour; make it match the page while typing.
    const tc = document.querySelector('meta[name="theme-color"]');
    const dark = tc?.content;
    const on = (e) => { if (isField(e.target)) { document.body.classList.add('typing'); if (tc) tc.content = '#f3f4f6'; } };
    const off = () => { document.body.classList.remove('typing'); if (tc && dark) tc.content = dark; };
    // A field that disappears while focused (a pop-up closing, a screen changing) never says goodbye, so check again after every tap.
    const settle = () => setTimeout(() => { if (!isField(document.activeElement)) off(); }, 0);
    document.addEventListener('focusin', on); document.addEventListener('focusout', off); document.addEventListener('click', settle);
    return () => { document.removeEventListener('focusin', on); document.removeEventListener('focusout', off); document.removeEventListener('click', settle); off(); };
  }, []);
  useEffect(() => { if (snap.authExpired) onAuthExpired(); }, [snap.authExpired, onAuthExpired]);
  // The number of customers who said yes and haven't been looked at yet, on the app icon (where the phone supports it).
  useEffect(() => {
    if (demo || !('setAppBadge' in navigator)) return;
    data.acceptances().then((list) => (list.length ? navigator.setAppBadge(list.length) : navigator.clearAppBadge?.())).catch(() => {});
  }, [data, snap.version, demo]);
  useEffect(() => { if (cfg.business.preset) applyTrade(cfg.business.preset); }, [cfg.business.preset]);

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
    <div className={`app${screen.name === 'quote' ? ' no-nav' : ''}`}>
      <header>
        <div className="topbar">
          <div className="brand">{cfg.business.name}</div>
          <button className="link" onClick={() => setScreen({ name: 'prices' })}>Prices</button>
          <button className="link" onClick={() => signOut(false)}>Sign out</button>
        </div>
        <StatusPill snap={snap} demo={demo} onClick={() => setSheet(true)} />
        {demo && <div className="demo-banner" role="note">Sample tour. These customers are pretend and nothing here is saved.</div>}
      </header>
      <main>
        <ErrorBoundary key={`${screen.name}:${screen.id ?? screen.jobId ?? ''}`} onBack={home}>
        {screen.name === 'board' && (
          <Board data={data} snap={snap} cfg={cfg} terms={terms} view={view} setView={setView}
            onAdd={(p) => setScreen({ name: 'add', phone: p.phone, prefill: p.name })}
            onOpen={(c) => setScreen({ name: 'client', id: c.id })}
            onQuote={(j) => setScreen({ name: 'quote', clientId: j.client_id, jobId: j.id, from: 'board' })} />
        )}
        {screen.name === 'add' && (
          <QuickAdd data={data} cfg={cfg} terms={terms} phone={screen.phone} initialName={screen.prefill}
            onCancel={home}
            onSaved={(client, created, sched) => {
              const offline = !data.getSnapshot().reachable;
              if (!sched && cfg.business.uses_visits !== false) { // saved as a new call: book the site visit when ready
                setToast(`${created ? '' : `Already a ${noun.toLowerCase()}. `}Saved. Book the site visit from New calls when you're ready.`);
                setView({ tab: 'estimates', q: '' });
                setScreen({ name: 'board' });
                return;
              }
              if (!sched) { // this business does not visit first: go straight to the quote
                const job = client.jobs[0];
                setScreen(job ? { name: 'quote', clientId: client.id, jobId: job.id, from: 'board' } : { name: 'board' });
                setView({ tab: 'estimates', q: '' });
                return;
              }
              const when = whenText(sched);
              setToast(`${created ? '' : `Already a ${noun.toLowerCase()}. `}Quote scheduled: ${when}${offline ? '. Saved on this phone, will sync when you have signal' : ''}`);
              setView({ tab: 'estimates', q: '' });
              setScreen({ name: 'board' });
            }} />
        )}
        {screen.name === 'quote' && (
          <QuoteBuilder demo={demo} data={data} snap={snap} cfg={cfg} clientId={screen.clientId} jobId={screen.jobId}
            onSent={() => { setView({ tab: 'quotes', q: '' }); setScreen({ name: 'board' }); }}
            onCopied={(ok, link) => {
              if (ok) { setLinkNote(''); setToast('Link copied. Paste it into a text or email.'); } else setLinkNote(link);
              setScreen({ name: 'client', id: screen.clientId });
            }}
            onBack={() => setScreen(screen.from === 'client' ? { name: 'client', id: screen.clientId } : { name: 'board' })} />
        )}
        {screen.name === 'prices' && <PriceList data={data} snap={snap} cfg={cfg} onBack={home} />}
        {screen.name === 'client' && linkNote && (
          <div className="banner banner-wait linknote" role="status">
            <div>Couldn’t copy the link automatically. Press and hold it to copy:</div>
            <input readOnly value={linkNote} aria-label="Quote link" onFocus={(e) => e.target.select()} />
            <button className="link" onClick={() => setLinkNote('')}>Done</button>
          </div>
        )}
        {screen.name === 'client' && (
          <ClientCard data={data} snap={snap} cfg={cfg} terms={terms} id={screen.id}
            onQuote={(j) => setScreen({ name: 'quote', clientId: screen.id, jobId: j.id, from: 'client' })}
            onBack={home} />
        )}
        </ErrorBoundary>
      </main>
      {screen.name !== 'quote' && <NavBar data={data} snap={snap} cfg={cfg} terms={terms} active={screen.name === 'board' && !view.q.trim() ? view.tab : null}
        onGo={(tab) => { setView({ tab, q: '' }); setScreen({ name: 'board' }); window.scrollTo(0, 0); }} />}
      {toast && <div className="toast" role="status">{toast}</div>}
      {ask?.kind === 'pending' && (
        <ConfirmSheet title="Sign out anyway?" danger confirmLabel="Sign out and lose them" cancelLabel="Stay signed in" onCancel={() => setAsk(null)} onConfirm={() => signOut(true)}>
          {ask.n} change{ask.n === 1 ? '' : 's'} on this phone haven’t synced yet and will be lost if you sign out. Connect to the internet and let them sync first if you can.
        </ConfirmSheet>
      )}
      {ask?.kind === 'offline' && (
        <ConfirmSheet title="No signal" confirmLabel="OK" cancelLabel="" onCancel={() => setAsk(null)} onConfirm={() => setAsk(null)}>
          Signing out needs a connection. Try again when you have signal.
        </ConfirmSheet>
      )}
      {sheet && <SyncSheet data={data} snap={snap} demo={demo} onTour={onTourStart} onClose={() => setSheet(false)} />}
      {demo && <Tour data={data} screen={screen.name} go={(tab) => { setView({ tab, q: '' }); setScreen({ name: 'board' }); window.scrollTo(0, 0); }} onEnd={onTourEnd} />}
    </div>
  );
}
