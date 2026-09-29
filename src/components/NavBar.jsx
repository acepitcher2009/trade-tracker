import { useEffect, useState } from 'react';

/** The five section tabs, on every screen. Counts come from this phone's own copy, so they work offline. */
export default function NavBar({ data, snap, cfg, terms, active, onGo }) {
  const [n, setN] = useState({ clients: 0, estimates: 0, quotes: 0, jobs: 0, payments: 0 });
  useEffect(() => {
    let live = true;
    if (!snap.ready) return undefined;
    Promise.all([data.board(), data.clientCount()]).then(([jobs, clients]) => {
      if (!live) return;
      const k = (key) => jobs.filter((j) => j.status_key === key).length;
      setN({ clients, estimates: k('new') + k('visit'), quotes: k('quoted'), jobs: k('accepted') + k('scheduled'), payments: k('done') });
    });
    return () => { live = false; };
  }, [data, snap.version, snap.ready]);
  const usesVisits = cfg.business.uses_visits !== false;
  const views = [
    ['clients', terms.clients || 'Clients'],
    ['estimates', usesVisits ? 'Quote Scheduled' : 'To Quote'],
    ['quotes', 'Quotes Sent'],
    ['jobs', 'Jobs'],
    ['payments', 'Payments'],
  ];
  return (
    <nav className="bottomnav" aria-label="Sections">
      {views.map(([key, label]) => (
        <button key={key} className={`bn${active === key ? ' on' : ''}`} aria-current={active === key ? 'page' : undefined} onClick={() => onGo(key)}>
          <span className="bn-n"><span className={`bn-badge${n[key] ? '' : ' bn-zero'}`}>{n[key]}</span></span>
          <span className="bn-label">{label}</span>
        </button>
      ))}
    </nav>
  );
}
