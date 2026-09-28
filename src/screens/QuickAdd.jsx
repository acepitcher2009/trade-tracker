import { useEffect, useRef, useState } from 'react';
import { formatPhone } from '../../shared/phone.js';

export default function QuickAdd({ data, cfg, terms, phone, onCancel, onSaved }) {
  const noun = terms.client || 'Client';
  const [name, setName] = useState('');
  const [jobType, setJobType] = useState(null);
  const [address, setAddress] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const nameRef = useRef(null);

  useEffect(() => { nameRef.current?.focus(); }, []);

  // Saves to this phone first (instant, works offline); the sync engine sends it to the server.
  const save = async (e) => {
    e.preventDefault();
    if (!name.trim()) { setErr('Enter a name.'); nameRef.current?.focus(); return; }
    setBusy(true); setErr('');
    try {
      const r = await data.createClient({ name, phone, address, notes, jobTypeId: jobType });
      onSaved(r.client, r.created);
    } catch (ex) { setErr(ex.message); setBusy(false); }
  };

  return (
    <form onSubmit={save} className="add">
      <button type="button" className="link back" onClick={onCancel}>← Back</button>
      <h1>Add {noun.toLowerCase()}</h1>
      <div className="phone-chip">{formatPhone(phone)}</div>

      <label className="field">Name
        <input ref={nameRef} value={name} onChange={(e) => setName(e.target.value)} autoComplete="off"
          autoCapitalize="words" placeholder="Full name" maxLength={120} />
      </label>

      <fieldset className="jobs">
        <legend>Job type</legend>
        <div className="job-grid">
          {cfg.job_types.map((t) => (
            <button type="button" key={t.id} className={`job-btn${jobType === t.id ? ' on' : ''}`}
              aria-pressed={jobType === t.id} onClick={() => setJobType(jobType === t.id ? null : t.id)}>
              {t.name}
            </button>
          ))}
        </div>
      </fieldset>

      <details className="more">
        <summary>More details (optional)</summary>
        <label className="field">Address
          <input value={address} onChange={(e) => setAddress(e.target.value)} autoComplete="off"
            placeholder="Street, city" maxLength={300} />
        </label>
        <label className="field">Notes
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} maxLength={4000} />
        </label>
      </details>

      {err && <p className="error" role="alert">{err}</p>}
      <button className="btn btn-primary btn-save" disabled={busy}>{busy ? 'Saving…' : `Save ${noun.toLowerCase()}`}</button>
    </form>
  );
}
