// The "can I trust this?" indicator: online/offline, syncing, changes waiting, or fully synced.
export function pillInfo(s) {
  if (s.failed > 0) return { cls: 'pill-bad', text: `${s.failed} need${s.failed === 1 ? 's' : ''} attention` };
  if (!s.reachable) return { cls: 'pill-off', text: s.pending ? `Offline · ${s.pending} waiting` : 'Offline' };
  if (s.syncing) return { cls: 'pill-busy', text: 'Syncing…' };
  if (s.pending > 0) return { cls: 'pill-off', text: `${s.pending} waiting to sync` };
  if (s.error) return { cls: 'pill-bad', text: 'Sync problem' };
  return { cls: 'pill-on', text: s.ready ? 'Synced' : 'Online' };
}

export default function StatusPill({ snap, onClick, demo }) {
  const { cls, text: liveText } = pillInfo(snap);
  const text = demo ? 'Sample tour' : liveText;
  return (
    <button className={`pill ${cls}`} onClick={onClick} aria-label={`Sync status: ${text}. Tap for details`}>
      <span className="dot" aria-hidden="true" />{text}
    </button>
  );
}
