import { useEffect, useState } from 'react';

// Online/offline indicator. Stage 5 extends this with the "synced" / pending-changes state.
export default function StatusPill() {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false);
    window.addEventListener('online', on); window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);
  return (
    <span className={`pill ${online ? 'pill-on' : 'pill-off'}`} role="status">
      <span className="dot" aria-hidden="true" />{online ? 'Online' : 'Offline'}
    </span>
  );
}
