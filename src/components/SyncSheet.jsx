import { pillInfo } from './StatusPill.jsx';

const ago = (iso) => {
  if (!iso) return 'never';
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  return new Date(iso).toLocaleString(undefined, { hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' });
};

export default function SyncSheet({ data, snap, onClose }) {
  const { text } = pillInfo(snap);
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
            <p className="sheet-line"><strong>These changes were rejected by the server:</strong></p>
            {snap.failedOps.map((f) => (
              <div key={f.seq} className="failed-row">
                <div><strong>{f.label}</strong><div className="hint">{f.error}</div></div>
                <button className="btn btn-small btn-ghost" onClick={() => data.discard(f.seq)}>Discard</button>
              </div>
            ))}
            <button className="btn btn-ghost" onClick={() => data.retryFailed()}>Try them again</button>
          </div>
        )}
        <div className="row">
          <button className="btn btn-primary" disabled={snap.syncing} onClick={() => data.sync()}>{snap.syncing ? 'Syncing…' : 'Sync now'}</button>
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
