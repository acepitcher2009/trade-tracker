import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { formatPhone, parseLookup } from '../../shared/phone.js';
import InstallTip from '../components/InstallTip.jsx';

// Keep only digits; a pasted "+1 (979) 555-1234" becomes 9795551234.
function clean(raw) {
  let d = raw.replace(/\D/g, '');
  if (d.length > 10 && d[0] === '1') d = d.slice(1);
  return d.slice(0, 10);
}

const fmtDate = (iso) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const jobsText = (n) => (n === 0 ? 'No jobs yet' : `${n} job${n === 1 ? '' : 's'}`);

function ClientInfo({ c }) {
  return (
    <>
      <div className="banner-name">{c.name}</div>
      <div className="banner-phone">{formatPhone(c.phone_digits)}</div>
      <div className="banner-jobs">
        {jobsText(c.job_count)}
        {c.job_count > 0 && <> · Last: {c.last_job_type} ({c.last_job_status}), {fmtDate(c.last_job_at)}</>}
      </div>
    </>
  );
}

export default function Lookup({ terms, initialQ, onAdd, onExpired }) {
  const noun = terms.client || 'Client';
  const [q, setQ] = useState(clean(initialQ || ''));
  const [result, setResult] = useState(null); // { q, mode, matches }
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [picked, setPicked] = useState(null);
  const input = useRef(null);

  useEffect(() => { input.current?.focus(); }, []);

  useEffect(() => {
    setPicked(null);
    const p = parseLookup(q);
    if (p.mode === 'partial') { setResult(null); setErr(''); setLoading(false); return; }
    const ctl = new AbortController();
    setLoading(true);
    const t = setTimeout(() => {
      api.lookup(q, ctl.signal)
        .then((r) => { setResult({ q, ...r }); setErr(''); })
        .catch((e) => {
          if (e.name === 'AbortError') return;
          if (e.status === 401) onExpired(); else setErr(e.message);
        })
        .finally(() => { if (!ctl.signal.aborted) setLoading(false); });
    }, p.mode === 'full' ? 0 : 150);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [q, onExpired]);

  const parsed = parseLookup(q);
  const fresh = result && result.q === q ? result : null;
  const shown = picked ? [picked] : fresh?.matches ?? [];

  let body = null;
  if (err) {
    body = <div className="banner banner-warn" role="alert">{err}</div>;
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
      <div className="banner banner-existing" role="status">
        <div className="banner-title">EXISTING {noun.toUpperCase()}</div>
        <ClientInfo c={shown[0]} />
      </div>
    );
  } else {
    body = (
      <div role="status">
        <p className="hint">{shown.length} {noun.toLowerCase()}s end in {parsed.last4} — tap one:</p>
        {shown.map((c) => (
          <button key={c.id} className="banner banner-existing banner-pick" onClick={() => setPicked(c)}>
            <ClientInfo c={c} />
          </button>
        ))}
      </div>
    );
  }

  return (
    <section>
      <label className="big-label" htmlFor="phone">Phone number</label>
      <input id="phone" ref={input} className="big-input" type="tel" inputMode="tel" autoComplete="off"
        autoFocus placeholder="Number or last 4" value={q}
        onChange={(e) => setQ(clean(e.target.value))} aria-describedby="phone-hint" />
      <div id="phone-hint" className="preview" aria-live="polite">
        {parsed.mode === 'full' ? formatPhone(parsed.digits) : loading ? '' : ' '}
      </div>
      {body}
      <InstallTip />
    </section>
  );
}
