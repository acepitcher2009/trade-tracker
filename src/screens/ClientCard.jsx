import { useEffect, useRef, useState } from 'react';
import { api, newId } from '../api.js';
import { formatPhone } from '../../shared/phone.js';
import { fmtDate } from '../format.js';

const isApple = /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent);
const mapsUrl = (addr) => isApple
  ? `https://maps.apple.com/?daddr=${encodeURIComponent(addr)}`
  : `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(addr)}`;

function JobRow({ job, statuses, onChange, busy }) {
  return (
    <li className="job">
      <div className="job-head">
        <span className="job-type">{job.job_type}</span>
        <span className="job-date">{fmtDate(job.created_at)}</span>
      </div>
      {job.notes && <div className="job-notes">{job.notes}</div>}
      <div className="status-row" role="group" aria-label={`Status for ${job.job_type}`}>
        {statuses.map((s) => {
          const on = s.id === job.status_id;
          return (
            <button key={s.id} type="button" className={`status-btn${on ? ' on' : ''}`} aria-pressed={on}
              disabled={busy} style={on ? { background: s.color, borderColor: s.color } : undefined}
              onClick={() => !on && onChange(job, s)}>
              {s.label}
            </button>
          );
        })}
      </div>
    </li>
  );
}

export default function ClientCard({ me, terms, id, onBack, onExpired }) {
  const noun = terms.client || 'Client';
  const [client, setClient] = useState(null);
  const [err, setErr] = useState('');
  const [busyJob, setBusyJob] = useState(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(false);

  const fail = (e) => { if (e.status === 401) onExpired(); else setErr(e.message); };

  useEffect(() => {
    let live = true;
    api.getClient(id).then((r) => live && setClient(r.client)).catch((e) => live && fail(e));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const changeStatus = async (job, status) => {
    const prev = client;
    setErr(''); setBusyJob(job.id);
    // Optimistic: one tap updates the screen immediately; revert if the server says no.
    setClient({ ...client, jobs: client.jobs.map((j) => j.id === job.id ? { ...j, status_id: status.id, status_key: status.key, status_label: status.label } : j) });
    try { await api.setStatus(job.id, status.id); }
    catch (e) { setClient(prev); fail(e); }
    finally { setBusyJob(null); }
  };

  if (!client) {
    return (
      <section>
        <button className="link back" onClick={onBack}>← Back</button>
        {err ? <div className="banner banner-warn" role="alert">{err}</div> : <div className="banner banner-wait" aria-busy="true">Loading…</div>}
      </section>
    );
  }

  const tel = `+1${client.phone_digits}`;
  return (
    <section className="card">
      <button className="link back" onClick={onBack}>← Back</button>
      <h1 className="card-name">{client.name}</h1>
      <div className="card-phone">{formatPhone(client.phone_digits)}</div>

      <div className={`actions${client.address ? ' actions-3' : ''}`}>
        <a className="btn btn-action" href={`tel:${tel}`}>Call</a>
        <a className="btn btn-action" href={`sms:${tel}`}>Text</a>
        {client.address && <a className="btn btn-action" href={mapsUrl(client.address)} target="_blank" rel="noopener noreferrer">Directions</a>}
      </div>

      {editing
        ? <EditForm client={client} noun={noun} onCancel={() => setEditing(false)} onExpired={onExpired}
            onSaved={(c) => { setClient(c); setEditing(false); }} />
        : (
          <div className="details">
            {client.address ? <div className="detail"><span className="detail-label">Address</span>{client.address}</div> : null}
            {client.notes ? <div className="detail"><span className="detail-label">Notes</span><span className="pre">{client.notes}</span></div> : null}
            <button className="link" onClick={() => setEditing(true)}>{client.address || client.notes ? 'Edit details' : 'Add address or notes'}</button>
          </div>
        )}

      {err && <p className="error" role="alert">{err}</p>}

      <div className="jobs-head">
        <h2>{terms.jobs || 'Jobs'} ({client.jobs.length})</h2>
        {!adding && <button className="btn btn-small btn-primary" onClick={() => setAdding(true)}>+ Add {(terms.job || 'job').toLowerCase()}</button>}
      </div>

      {adding && <AddJob me={me} terms={terms} clientId={client.id} onExpired={onExpired} onCancel={() => setAdding(false)}
        onSaved={(job) => { setClient((c) => ({ ...c, jobs: [job, ...c.jobs.filter((j) => j.id !== job.id)] })); setAdding(false); }} />}

      {client.jobs.length === 0 && !adding && <p className="hint">No {(terms.jobs || 'jobs').toLowerCase()} yet.</p>}
      <ul className="job-list">
        {client.jobs.map((j) => <JobRow key={j.id} job={j} statuses={me.statuses} busy={busyJob === j.id} onChange={changeStatus} />)}
      </ul>
    </section>
  );
}

function AddJob({ me, terms, clientId, onSaved, onCancel, onExpired }) {
  const [type, setType] = useState(null);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const jobId = useRef(newId()); // retry-safe

  const save = async () => {
    if (!type) { setErr('Pick a job type.'); return; }
    setBusy(true); setErr('');
    try {
      const r = await api.addJob(clientId, { id: jobId.current, job_type_id: type, notes: notes || undefined });
      onSaved(r.job);
    } catch (e) { if (e.status === 401) return onExpired(); setErr(e.message); setBusy(false); }
  };

  return (
    <div className="panel">
      <div className="job-grid">
        {me.job_types.map((t) => (
          <button type="button" key={t.id} className={`job-btn${type === t.id ? ' on' : ''}`} aria-pressed={type === t.id}
            onClick={() => setType(type === t.id ? null : t.id)}>{t.name}</button>
        ))}
      </div>
      <label className="field">Notes (optional)
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} maxLength={4000} />
      </label>
      {err && <p className="error" role="alert">{err}</p>}
      <div className="row">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : `Save ${(terms.job || 'job').toLowerCase()}`}</button>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function EditForm({ client, noun, onSaved, onCancel, onExpired }) {
  const [name, setName] = useState(client.name);
  const [address, setAddress] = useState(client.address || '');
  const [notes, setNotes] = useState(client.notes || '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const save = async (e) => {
    e.preventDefault();
    if (!name.trim()) { setErr('Name can’t be empty.'); return; }
    setBusy(true); setErr('');
    try {
      const r = await api.patchClient(client.id, { name, address, notes });
      onSaved(r.client);
    } catch (ex) { if (ex.status === 401) return onExpired(); setErr(ex.message); setBusy(false); }
  };

  return (
    <form className="panel" onSubmit={save}>
      <label className="field">Name<input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoCapitalize="words" /></label>
      <label className="field">Address<input value={address} onChange={(e) => setAddress(e.target.value)} maxLength={300} placeholder="Street, city" /></label>
      <label className="field">Notes<textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} maxLength={4000} /></label>
      {err && <p className="error" role="alert">{err}</p>}
      <div className="row">
        <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
