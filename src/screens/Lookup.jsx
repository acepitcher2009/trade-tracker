import { useEffect, useRef, useState } from 'react';
import { formatPhone, parseLookup } from '../../shared/phone.js';
import InstallTip from '../components/InstallTip.jsx';
import { fmtDate, jobsText } from '../format.js';

// Keep only digits; a pasted "+1 (979) 555-1234" becomes 9795551234.
function clean(raw) {
  let d = raw.replace(/\D/g, '');
  if (d.length > 10 && d[0] === '1') d = d.slice(1);
  return d.slice(0, 10);
}

function ClientInfo({ c }) {
  return (
    <>
      <div className="banner-name">{c.name}</div>
      <div className="banner-phone">{formatPhone(c.phone_digits)}</div>
      <div className="banner-jobs">
        {jobsText(c.job_count)}
        {c.job_count > 0 && <> · Last: {c.last_job_type} ({c.last_job_status}), {fmtDate(c.last_job_at)}</>}
      </div>
      {c.pending && <div className="chip">Not synced yet</div>}
    </>
  );
}

export default function Lookup({ data, snap, terms, initialQ, onAdd, onOpen }) {
  const noun = terms.client || 'Client';
  const [q, setQ] = useState(clean(initialQ || ''));
  const [result, setResult] = useState(null); // { q, mode, matches }
  const input = useRef(null);

  useEffect(() => { input.current?.focus(); }, []);

  // Reads only from the copy on this phone, so it is instant and works with no signal.
  // Re-runs whenever a sync changes the local data (snap.version).
  useEffect(() => {
    let live = true;
    if (parseLookup(q).mode === 'partial' || !snap.ready) { setResult(null); return undefined; }
    data.lookup(q).then((r) => { if (live) setResult({ q, ...r }); });
    return () => { live = false; };
  }, [q, snap.version, snap.ready, data]);

  const parsed = parseLookup(q);
  const fresh = result && result.q === q ? result : null;
  const shown = fresh?.matches ?? [];

  let body = null;
  if (!snap.ready) {
    // Never show "NEW CLIENT" before the first download finishes: it could be wrong.
    body = snap.syncing || snap.reachable
      ? <div className="banner banner-wait" aria-busy="true">Downloading your {(terms.clients || 'clients').toLowerCase()}…</div>
      : <div className="banner banner-warn" role="alert">Connect to the internet once to download your {(terms.clients || 'clients').toLowerCase()}. After that, lookups work with no signal.</div>;
  } else if (parsed.mode === 'partial') {
    body = <p className="hint">Type the full phone number, or just the last 4 digits.</p>;
  } else if (!fresh) {
    body = <div className="banner banner-wait" aria-busy="true">Checking…</div>;
  } else if (parsed.mode === 'full' && shown.length === 0) {
    body = (
      <div className="banner banner-new" role="status">
        <div className="banner-title">NEW {noun.toUpperCase()}</div>
        <div className="banner-phone">{formatPhone(parsed.digits)}</div>
        <button className="btn btn-light" onClick={() => onAdd(parsed.digits)}>Add {noun.toLowerCase()}</button>
      </div>
    );
  } else if (shown.length === 0) {
    body = (
      <div className="banner banner-new" role="status">
        <div className="banner-title">NO MATCH</div>
        <div className="banner-jobs">Nobody's number ends in {parsed.last4}. Enter the full number to add a {noun.toLowerCase()}.</div>
      </div>
    );
  } else if (shown.length === 1) {
    body = (
      <button className="banner banner-existing banner-pick" onClick={() => onOpen(shown[0])}>
        <div className="banner-title">EXISTING {noun.toUpperCase()}</div>
        <ClientInfo c={shown[0]} />
        <div className="banner-open">Open {noun.toLowerCase()} card ›</div>
      </button>
    );
  } else {
    body = (
      <div role="status">
        <p className="hint">{shown.length} {noun.toLowerCase()}s end in {parsed.last4} — tap one:</p>
        {shown.map((c) => (
          <button key={c.id} className="banner banner-existing banner-pick" onClick={() => onOpen(c)}>
            <ClientInfo c={c} />
          </button>
        ))}
      </div>
    );
  }

  return (
    <section>
      <h1 className="sr-only">Look up a {noun.toLowerCase()}</h1>
      <label className="big-label" htmlFor="phone">Phone number</label>
      <input id="phone" ref={input} className="big-input" type="tel" inputMode="tel" autoComplete="off"
        autoFocus placeholder="Number or last 4" value={q}
        onChange={(e) => setQ(clean(e.target.value))} aria-describedby="phone-hint" />
      <div id="phone-hint" className="preview" aria-live="polite">
        {parsed.mode === 'full' ? formatPhone(parsed.digits) : ' '}
      </div>
      {body}
      <InstallTip />
    </section>
  );
}
