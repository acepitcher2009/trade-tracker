import { useEffect, useState } from 'react';
import { formatPhone } from '../../shared/phone.js';
import { fmtDate } from '../format.js';

const isApple = /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent);
const mapsUrl = (addr) => isApple
  ? `https://maps.apple.com/?daddr=${encodeURIComponent(addr)}`
  : `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(addr)}`;

function JobRow({ job, statuses, onChange }) {
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
              style={on ? { background: s.color, borderColor: s.color } : undefined}
              onClick={() => !on && onChange(job, s)}>
              {s.label}
            </button>
          );
        })}
      </div>
    </li>
  );
}

export default function ClientCard({ data, snap, cfg, terms, id, onBack }) {
  const [curId, setCurId] = useState(id);
  const [client, setClient] = useState(undefined); // undefined = loading, null = missing
  const [err, setErr] = useState('');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(false);

  // Read from the phone's own copy; refresh after any local change or sync (snap.version).
  useEffect(() => {
    let live = true;
    data.getCard(curId).then((c) => {
      if (!live) return;
      setClient(c);
      if (c && c.id !== curId) setCurId(c.id); // merged into the server's record for that phone number
    });
    return () => { live = false; };
  }, [data, curId, snap.version]);

  const run = async (fn) => { setErr(''); try { await fn(); } catch (e) { setErr(e.message); } };

  if (!client) {
    return (
      <section>
        <button className="link back" onClick={onBack}>← Back</button>
        {client === null
          ? <div className="banner banner-warn" role="alert">This record isn't on this phone anymore.</div>
          : <div className="banner banner-wait" aria-busy="true">Loading…</div>}
      </section>
    );
  }

  const tel = `+1${client.phone_digits}`;
  return (
    <section className="card">
      <button className="link back" onClick={onBack}>← Back</button>
      <h1 className="card-name">{client.name}</h1>
      <div className="card-phone">{formatPhone(client.phone_digits)}</div>
      {client.pending && <div className="chip chip-dark">Not synced yet</div>}

      <div className={`actions${client.address ? ' actions-3' : ''}`}>
        <a className="btn btn-action" href={`tel:${tel}`}>Call</a>
        <a className="btn btn-action" href={`sms:${tel}`}>Text</a>
        {client.address && <a className="btn btn-action" href={mapsUrl(client.address)} target="_blank" rel="noopener noreferrer">Directions</a>}
      </div>

      {editing
        ? <EditForm client={client} onCancel={() => setEditing(false)}
            onSave={(fields) => run(async () => { await data.patchClient(client.id, fields); setEditing(false); })} />
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

      {adding && <AddJob cfg={cfg} terms={terms} onCancel={() => setAdding(false)}
        onSave={(body) => run(async () => { await data.addJob(client.id, body); setAdding(false); })} />}

      {client.jobs.length === 0 && !adding && <p className="hint">No {(terms.jobs || 'jobs').toLowerCase()} yet.</p>}
      <ul className="job-list">
        {client.jobs.map((j) => <JobRow key={j.id} job={j} statuses={cfg.statuses}
          onChange={(job, s) => run(() => data.setStatus(job.id, s.id))} />)}
      </ul>
    </section>
  );
}

function AddJob({ cfg, terms, onSave, onCancel }) {
  const [type, setType] = useState(null);
  const [notes, setNotes] = useState('');
  const [err, setErr] = useState('');

  return (
    <div className="panel">
      <div className="job-grid">
        {cfg.job_types.map((t) => (
          <button type="button" key={t.id} className={`job-btn${type === t.id ? ' on' : ''}`} aria-pressed={type === t.id}
            onClick={() => setType(type === t.id ? null : t.id)}>{t.name}</button>
        ))}
      </div>
      <label className="field">Notes (optional)
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} maxLength={4000} />
      </label>
      {err && <p className="error" role="alert">{err}</p>}
      <div className="row">
        <button type="button" className="btn btn-primary" onClick={() => (type ? onSave({ jobTypeId: type, notes }) : setErr('Pick a job type.'))}>
          Save {(terms.job || 'job').toLowerCase()}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function EditForm({ client, onSave, onCancel }) {
  const [name, setName] = useState(client.name);
  const [address, setAddress] = useState(client.address || '');
  const [notes, setNotes] = useState(client.notes || '');
  const [err, setErr] = useState('');

  const submit = (e) => {
    e.preventDefault();
    if (!name.trim()) { setErr('Name can’t be empty.'); return; }
    // Only send what actually changed, so we never overwrite someone else's edit to another field.
    const fields = {};
    if (name.trim() !== client.name) fields.name = name;
    if (address.trim() !== (client.address || '')) fields.address = address;
    if (notes.trim() !== (client.notes || '')) fields.notes = notes;
    if (!Object.keys(fields).length) return onCancel();
    onSave(fields);
  };

  return (
    <form className="panel" onSubmit={submit}>
      <label className="field">Name<input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoCapitalize="words" /></label>
      <label className="field">Address<input value={address} onChange={(e) => setAddress(e.target.value)} maxLength={300} placeholder="Street, city" /></label>
      <label className="field">Notes<textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} maxLength={4000} /></label>
      {err && <p className="error" role="alert">{err}</p>}
      <div className="row">
        <button className="btn btn-primary">Save</button>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
