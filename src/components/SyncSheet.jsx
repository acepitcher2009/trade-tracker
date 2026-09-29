import { useEffect, useState } from 'react';
import { pillInfo } from './StatusPill.jsx';
import { disablePush, enablePush, pushState } from '../push.js';

const WHY = {
  unsupported: 'Alerts work in the installed app. Add it to your home screen, then open it from there.',
  unavailable: 'Alerts are not switched on for this site yet.',
  blocked: 'Alerts are blocked for this app. Turn them on in your phone’s settings, then come back here.',
};

const ago = (iso) => {
  if (!iso) return 'never';
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  return new Date(iso).toLocaleString(undefined, { hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' });
};

export default function SyncSheet({ data, snap, onClose, demo, onTour }) {
  const { text } = pillInfo(snap);
  const [alerts, setAlerts] = useState('checking');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { let live = true; pushState().then((r) => live && setAlerts(r)); return () => { live = false; }; }, []);
  const toggleAlerts = async () => {
    setErr(''); setBusy(true);
    try { if (alerts === 'on') { await disablePush(); setAlerts('off'); } else { await enablePush(); setAlerts('on'); } }
    catch (e) { setErr(e.status === 0 ? 'This needs a connection. Try again when you have signal.' : e.message); }
    finally { setBusy(false); }
  };
  return (
    <div className="sheet-back" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label="Sync status" onClick={(e) => e.stopPropagation()}>
        <h2>{text}</h2>
        <p className="sheet-line">Last synced: <strong>{ago(snap.lastSyncAt)}</strong></p>
        {!snap.reachable && <p className="sheet-line">No signal right now. Everything you add is saved on this phone and sends automatically when you're back online.</p>}
        {snap.pending > 0 && <p className="sheet-line">{snap.pending} change{snap.pending === 1 ? '' : 's'} waiting to send.</p>}
        {snap.error && <p className="error">{snap.error}</p>}
        {snap.failedOps.length > 0 && (
          <div className="failed">
            <p className="sheet-line"><strong>These changes could not be saved:</strong></p>
            {snap.failedOps.map((f) => (
              <div key={f.seq} className="failed-row">
                <div><strong>{f.label}</strong><div className="hint">{f.error}</div></div>
                <button className="btn btn-small btn-ghost" onClick={() => data.discard(f.seq)}>Discard</button>
              </div>
            ))}
            <button className="btn btn-ghost" onClick={() => data.retryFailed()}>Try them again</button>
          </div>
        )}
        {!demo && <div className="sheet-gap">
          <p className="sheet-line"><strong>Quote accepted alerts.</strong> A message on this phone the moment a customer says yes.</p>
          {err && <p className="error" role="alert">{err}</p>}
          {WHY[alerts]
            ? <p className="hint">{WHY[alerts]}</p>
            : <button className="btn btn-ghost" disabled={busy || alerts === 'checking'} onClick={toggleAlerts}>{alerts === 'on' ? 'Alerts are on. Turn off' : 'Turn on alerts on this phone'}</button>}
        </div>}
        {demo && <p className="sheet-line">This is the sample tour. Nothing here is saved or sent.</p>}
        {onTour && !demo && <button className="btn btn-ghost" onClick={() => { onClose(); onTour(); }}>Replay the app tour</button>}
        {snap.reachable && !demo && (
          <a className="btn btn-ghost btn-link" href="/api/export?format=csv" download>Download my data (spreadsheet)</a>
        )}
        <div className="row">
          <button className="btn btn-primary" disabled={snap.syncing} onClick={() => data.sync()}>{snap.syncing ? 'Syncing…' : 'Sync now'}</button>
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
