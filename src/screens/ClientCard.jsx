import { useEffect, useState } from 'react';
import { formatPhone } from '../../shared/phone.js';
import { fmtDate, fmtDay, whenText } from '../format.js';
import ScheduleSheet from '../components/ScheduleSheet.jsx';
import Kind from '../components/Kind.jsx';
import { money } from '../../shared/quote.js';
import AddressFields from '../components/AddressFields.jsx';
import { validateAddress } from '../../shared/address.js';
import PaymentSheet from '../components/PaymentSheet.jsx';
import { EVERY_LABEL } from '../data.js';

const METHOD_LABEL = { cash: 'Cash', check: 'Check', card: 'Card', transfer: 'Zelle / Venmo', other: 'Other' };

const DATED = new Set(['visit', 'scheduled']);
const SHEET_TITLE = { visit: 'When are you going to look at it?', scheduled: 'When is the job?' };
const isApple = /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent);
const mapsUrl = (addr) => isApple
  ? `https://maps.apple.com/?daddr=${encodeURIComponent(addr)}`
  : `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(addr)}`;

const CHANGEABLE = new Set(['accepted', 'scheduled', 'done', 'paid']);

function JobDetails({ job, onSave, onClose }) {
  const [days, setDays] = useState(String(job.duration_days ?? 1));
  const [who, setWho] = useState(job.assigned_to ?? '');
  const [every, setEvery] = useState(job.recurrence?.every ?? '');
  const [notes, setNotes] = useState(job.notes ?? '');
  return (
    <form className="panel" onSubmit={(e) => { e.preventDefault(); onSave({ duration_days: parseInt(days, 10) || 1, assigned_to: who.trim() || null, recurrence: every ? { every } : null, notes: notes.trim() || null }); }}>
      <label className="field">Job notes
        <textarea rows={3} maxLength={4000} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Gate code, materials ordered, dog in the yard…" />
      </label>
      <div className="row">
        <label className="field">Days it takes<input inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value.replace(/\D/g, ''))} /></label>
        <label className="field">Who does it<input value={who} maxLength={60} onChange={(e) => setWho(e.target.value)} placeholder="Crew or sub" /></label>
      </div>
      <label className="field">Repeats
        <select value={every} onChange={(e) => setEvery(e.target.value)}>
          <option value="">Does not repeat</option>
          {Object.entries(EVERY_LABEL).map(([k, l]) => <option key={k} value={k}>{l[0].toUpperCase() + l.slice(1)}</option>)}
        </select>
      </label>
      <p className="hint">A repeating job books its next visit automatically when you mark it done.</p>
      <div className="row">
        <button className="btn btn-primary">Save</button>
        <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
      </div>
    </form>
  );
}

// The one obvious next move for each stage: [status it moves to, button label].
const NEXT = { new: ['visit', 'Schedule visit'], quoted: ['accepted', 'They said yes'], accepted: ['scheduled', 'Schedule job'], scheduled: ['done', 'Mark done'], done: ['paid', 'Record payment'] };

function JobRow({ job, statuses, onChange, onReschedule, onQuote, onDetails, onChangeOrder, onPay, onUnpay }) {
  const [editing, setEditing] = useState(false);
  const [allStages, setAllStages] = useState(false);
  const cur = statuses.find((x) => x.id === job.status_id);
  const nextKey = NEXT[job.status_key]?.[0];
  const next = statuses.find((x) => x.key === nextKey);
  const facts = [job.duration_days > 1 ? `${job.duration_days} days` : '', job.assigned_to ? `Assigned to ${job.assigned_to}` : '', job.recurrence ? `Repeats ${EVERY_LABEL[job.recurrence.every]}` : ''].filter(Boolean).join(' · ');
  return (
    <li className="job">
      <div className="job-head">
        <span className="job-type">{job.job_type}{job.parent_job_id && <span className="qtag qtag-opt">Change order</span>}</span>
        <span className="job-date">{fmtDate(job.created_at)}</span>
      </div>
      {job.notes && <div className="job-notes">{job.notes}</div>}
      {facts && <div className="job-facts">{facts}</div>}
      {editing && <JobDetails job={job} onClose={() => setEditing(false)} onSave={(f) => { setEditing(false); onDetails(job, f); }} />}
      {job.scheduled_date && (
        <div className="when-row">
          <span className="when">{job.status_key === 'visit' ? 'Site visit · ' : ''}{whenText(job)}</span>
          <button type="button" className="link" onClick={() => onReschedule(job)}>Change</button>
        </div>
      )}
      <div className="quote-row">
        {job.quote ? (
          <>
            <span><strong>{money(job.quote_total_cents)}</strong> quote
              {job.quote_accepted_at ? <span className="accepted"> Accepted ✓</span> : job.quote.sent_at ? <span className="sent"> Sent</span> : null}</span>
            <button type="button" className="link" onClick={() => onQuote(job)}>Open quote</button>
          </>
        ) : <button type="button" className="btn btn-small btn-ghost" onClick={() => onQuote(job)}>Create quote</button>}
      </div>
      <div className="job-links">
        {!editing && <button type="button" className="link" onClick={() => setEditing(true)}>Job details</button>}
        {CHANGEABLE.has(job.status_key) && <button type="button" className="link" onClick={() => onChangeOrder(job)}>Add change order</button>}
      </div>
      {(job.payments.length > 0 || (job.quote && ['accepted', 'scheduled', 'done', 'paid'].includes(job.status_key))) && (
        <div className="pay-box">
          {job.paid_cents > 0 && <div className="paidline">Paid {money(job.paid_cents)}{job.quote_total_cents != null ? ` of ${money(job.quote_total_cents)}` : ''}{job.balance_cents > 0 ? ` · ${money(job.balance_cents)} owed` : ''}</div>}
          {job.payments.length > 0 && (
            <ul className="pay-list">
              {job.payments.map((p) => (
                <li key={p.id}><span>{fmtDay(p.date)} · {METHOD_LABEL[p.method] ?? 'Other'}{p.note ? ` · ${p.note}` : ''}</span>
                  <span><strong>{money(p.amount_cents)}</strong> <button type="button" className="link" aria-label={`Remove ${money(p.amount_cents)} payment`} onClick={() => onUnpay(job, p)}>Remove</button></span></li>
              ))}
            </ul>
          )}
          {job.status_key !== 'done' && job.quote && ['accepted', 'scheduled', 'done', 'paid'].includes(job.status_key) && <button type="button" className="link" onClick={() => onPay(job)}>Record a payment or deposit</button>}
        </div>
      )}
      <div className="stage-row">
        <span className="stage-pill" style={cur ? { background: cur.color } : undefined}>{cur?.label ?? job.status_key}</span>
        {next && <button type="button" className="btn btn-primary stage-next" onClick={() => (job.status_key === 'done' ? onPay(job) : onChange(job, next))}>{NEXT[job.status_key][1]}</button>}
      </div>
      <button type="button" className="link stage-change" onClick={() => setAllStages((v) => !v)}>{allStages ? 'Hide stages' : 'Change stage'}</button>
      {allStages && (
        <div className="status-row" role="group" aria-label={`Status for ${job.job_type}`}>
          {statuses.map((s) => {
            const on = s.id === job.status_id;
            return (
              <button key={s.id} type="button" className={`status-btn${on ? ' on' : ''}`} aria-pressed={on}
                style={on ? { background: s.color, borderColor: s.color } : undefined}
                onClick={() => { if (!on) { setAllStages(false); onChange(job, s); } }}>
                {s.label}
              </button>
            );
          })}
        </div>
      )}
    </li>
  );
}

export default function ClientCard({ data, snap, cfg, terms, id, onBack, onQuote }) {
  const [curId, setCurId] = useState(id);
  const [client, setClient] = useState(undefined); // undefined = loading, null = missing
  const [err, setErr] = useState('');
  const [editing, setEditing] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [sheet, setSheet] = useState(null); // { job, status? } -> schedule picker
  const [bookings, setBookings] = useState([]);
  const [newQuote, setNewQuote] = useState(null); // waiting for a visit time
  const [payFor, setPayFor] = useState(null);
  const [unpay, setUnpay] = useState(null);
  const visits = cfg.business.uses_visits !== false;
  useEffect(() => { if (sheet || newQuote) data.bookings().then(setBookings); }, [sheet, newQuote, data]);


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

  // No job-type question: the kind of job is picked later, in the quote form.
  const startQuote = () => {
    if (visits) setNewQuote({});
    else run(async () => { onQuote(await data.addJob(client.id, {})); });
  };
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
      <h1 className="card-name">{client.name}<Kind existing={client.existing} /></h1>
      <div className="card-phone">{formatPhone(client.phone_digits)}</div>
      {client.pending && <div className="chip chip-dark">Not synced yet</div>}

      <div className={`actions${client.address_complete ? ' actions-3' : ''}`}>
        <a className="btn btn-action" href={`tel:${tel}`}>Call</a>
        <a className="btn btn-action" href={`sms:${tel}`}>Text</a>
        {client.address_complete && <a className="btn btn-action" href={mapsUrl(client.address)} target="_blank" rel="noopener noreferrer">Directions</a>}
      </div>

      {editing
        ? <EditForm client={client} onCancel={() => setEditing(false)}
            onSave={(fields) => run(async () => { await data.patchClient(client.id, fields); setEditing(false); })} />
        : (
          <div className="details">
            {client.address ? <div className="detail"><span className="detail-label">Address</span>{client.address}</div> : null}
            {!client.address_complete && (
              <div className="needs-addr" role="alert">
                <strong>Full address needed:</strong> house number, street, city, state and ZIP.
                <button className="btn btn-small btn-primary" onClick={() => setEditing(true)}>Add full address</button>
              </div>
            )}
            {client.notes ? <div className="detail"><span className="detail-label">Notes</span><span className="pre">{client.notes}</span></div> : null}
            <button className="link" onClick={() => setEditing(true)}>Edit details</button>
          </div>
        )}

      {err && <p className="error" role="alert">{err}</p>}

      <div className="jobs-head">
        <h2>{terms.jobs || 'Jobs'} ({client.jobs.length})</h2>
        <button className="btn btn-small btn-primary" onClick={startQuote}>{visits ? 'Schedule new quote' : 'New quote'}</button>
      </div>

      {newQuote && (
        <ScheduleSheet title="When are you going to look at it?" who={client.name}
          bookings={bookings} confirmLabel="Schedule quote" onClose={() => setNewQuote(null)}
          onSave={(date, time) => { setNewQuote(null); run(async () => { await data.addJob(client.id, { schedule: { date, time } }); }); }} />
      )}

      {client.jobs.length === 0 && <p className="hint">No {(terms.jobs || 'jobs').toLowerCase()} yet.</p>}
      <ul className="job-list">
        {client.jobs.map((j) => <JobRow key={j.id} job={j} statuses={cfg.business.uses_visits === false ? cfg.statuses.filter((s) => s.key !== 'visit') : cfg.statuses}
          onReschedule={(job) => setSheet({ job })} onQuote={onQuote}
          onDetails={(job, f) => run(() => data.patchJob(job.id, f))}
          onPay={(job) => setPayFor(job)} onUnpay={(job, p) => setUnpay({ job, p })}
          onChangeOrder={(job) => run(async () => { const n = await data.addJob(client.id, { jobTypeId: job.job_type_id, parentJobId: job.id, notes: 'Change order' }); onQuote(n); })}
          onChange={(job, s) => (DATED.has(s.key) ? setSheet({ job, status: s }) : run(() => data.setStatus(job.id, s.id)))} />)}
      </ul>
      {!editing && (
        <button type="button" className="btn btn-danger-ghost" onClick={() => setConfirmDel(true)}>Delete client</button>
      )}
      {confirmDel && (
        <div className="sheet-back" onClick={() => setConfirmDel(false)}>
          <div className="sheet" role="alertdialog" aria-modal="true" aria-label={`Delete ${client.name}`} onClick={(e) => e.stopPropagation()}>
            <h2>Delete {client.name}?</h2>
            <p className="hint">This permanently removes them and their {client.jobs.length} {client.jobs.length === 1 ? 'job' : 'jobs'}, quotes and schedule. It can’t be undone.</p>
            <div className="row">
              <button type="button" className="btn btn-danger" onClick={() => run(async () => { await data.deleteClient(client.id); setConfirmDel(false); onBack(); })}>Yes, delete</button>
              <button type="button" className="btn btn-ghost" autoFocus onClick={() => setConfirmDel(false)}>Keep client</button>
            </div>
          </div>
        </div>
      )}
      {payFor && (
        <PaymentSheet who={`${client.name} · ${payFor.job_type}`} owed={payFor.balance_cents ?? 0} onClose={() => setPayFor(null)}
          onSave={(p) => { const j = payFor; setPayFor(null); run(() => data.addPayment(j.id, p)); }} />
      )}
      {unpay && (
        <div className="sheet-back" onClick={() => setUnpay(null)}>
          <div className="sheet" role="alertdialog" aria-modal="true" aria-label="Remove payment" onClick={(e) => e.stopPropagation()}>
            <h2>Remove this payment?</h2>
            <p className="hint">{money(unpay.p.amount_cents)} on {fmtDay(unpay.p.date)} will come off what {client.name.split(' ')[0]} has paid.</p>
            <div className="row">
              <button type="button" className="btn btn-danger" onClick={() => { const u = unpay; setUnpay(null); run(() => data.removePayment(u.job.id, u.p.id)); }}>Remove payment</button>
              <button type="button" className="btn btn-ghost" autoFocus onClick={() => setUnpay(null)}>Keep it</button>
            </div>
          </div>
        </div>
      )}
      {sheet && (
        <ScheduleSheet title={sheet.status ? (SHEET_TITLE[sheet.status.key] ?? 'Pick a day') : 'Change date'} who={sheet.job.job_type}
          initialDate={sheet.job.scheduled_date} initialTime={sheet.job.scheduled_time}
          bookings={bookings} excludeJobId={sheet.job.id} assignedTo={sheet.job.assigned_to}
          confirmLabel={sheet.status ? 'Schedule' : 'Save'}
          onClose={() => setSheet(null)}
          onSave={(date, time) => { const { job, status } = sheet; setSheet(null);
            run(() => (status ? data.setStatus(job.id, status.id, { date, time }) : data.setSchedule(job.id, { date, time }))); }}
          onClear={sheet.job.scheduled_date && !sheet.status ? () => { const { job } = sheet; setSheet(null); run(() => data.setSchedule(job.id, { date: null, time: null })); } : undefined} />
      )}
    </section>
  );
}

function EditForm({ client, onSave, onCancel }) {
  const [name, setName] = useState(client.name);
  const [addr, setAddr] = useState({ line: client.address_line || '', city: client.city || '', state: client.state || 'TX', zip: client.zip || '' });
  const [notes, setNotes] = useState(client.notes || '');
  const [err, setErr] = useState('');

  const submit = (e) => {
    e.preventDefault();
    if (!name.trim()) { setErr('Name can’t be empty.'); return; }
    const av = validateAddress(addr); // every client needs a full address
    if (!av.ok) { setErr(av.error); return; }
    // Only send what actually changed, so we never overwrite someone else's edit to another field.
    const fields = {};
    if (name.trim() !== client.name) fields.name = name;
    const v = av.value;
    if (!client.address_complete || v.line !== client.address_line || v.city !== client.city || v.state !== client.state || v.zip !== client.zip) {
      Object.assign(fields, { addressLine: v.line, city: v.city, state: v.state, zip: v.zip });
    }
    if (notes.trim() !== (client.notes || '')) fields.notes = notes;
    if (!Object.keys(fields).length) return onCancel();
    onSave(fields);
  };

  return (
    <form className="panel" onSubmit={submit}>
      <label className="field">Name<input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoCapitalize="words" /></label>
      {!client.address_complete && client.address && <p className="hint">On file: {client.address}. Re-enter it in full below.</p>}
      <AddressFields value={addr} onChange={setAddr} />
      <label className="field">Notes<textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} maxLength={4000} /></label>
      {err && <p className="error" role="alert">{err}</p>}
      <div className="row">
        <button className="btn btn-primary">Save</button>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
