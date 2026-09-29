import { useEffect, useRef, useState } from 'react';
import { formatPhone, normalizePhone } from '../../shared/phone.js';
import { validateAddress } from '../../shared/address.js';
import AddressFields from '../components/AddressFields.jsx';
import ScheduleSheet from '../components/ScheduleSheet.jsx';

export default function QuickAdd({ data, cfg, terms, phone: initialPhone, initialName, onCancel, onSaved }) {
  const noun = terms.client || 'Client';
  const [name, setName] = useState(initialName || '');
  const [phone, setPhone] = useState(initialPhone ? formatPhone(initialPhone.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '')) : '');
  const [addr, setAddr] = useState({ line: '', city: '', state: cfg.business.state || 'TX', zip: '' });
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false); // the schedule pop-up
  const [bookings, setBookings] = useState([]);
  const [err, setErr] = useState('');
  const nameRef = useRef(null);
  const visits = cfg.business.uses_visits !== false;

  useEffect(() => { nameRef.current?.focus(); }, []);

  // Step 1: check the form, then ask when Deno is going to look at the job. Nothing is saved until he picks a time.
  const check = () => {
    if (!name.trim()) { setErr('Enter a name.'); nameRef.current?.focus(); return false; }
    if (!normalizePhone(phone)) { setErr('Enter a valid 10-digit phone number.'); return false; }
    const av = validateAddress(addr);
    if (!av.ok) { setErr(av.error); return false; }
    setErr('');
    return true;
  };
  const next = (e) => {
    e.preventDefault();
    if (!check()) return;
    if (!visits) { save(null, null); return; } // no site visit: straight to the quote
    data.bookings().then(setBookings);
    setPicking(true);
  };

  // Step 2: he picked a day and time. Save the client and the booked visit together (to this phone first, so it works offline).
  const save = async (date, time) => {
    setPicking(false); setBusy(true); setErr('');
    try {
      const r = await data.createClient({ name, phone, addressLine: addr.line, city: addr.city, state: addr.state, zip: addr.zip, notes, schedule: date ? { date, time } : undefined });
      onSaved(r.client, r.created, date ? { scheduled_date: date, scheduled_time: time } : null);
    } catch (ex) { setErr(ex.message); setBusy(false); }
  };

  return (
    <>
    <form onSubmit={next} className="add">
      <button type="button" className="link back" onClick={onCancel}>← Back</button>
      <h1>Add {noun.toLowerCase()}</h1>
      <label className="field">Phone number
        <input type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="off"
          placeholder="(979) 555-1234" maxLength={20} />
      </label>

      <label className="field">Name
        <input ref={nameRef} value={name} onChange={(e) => setName(e.target.value)} autoComplete="off"
          autoCapitalize="words" placeholder="Full name" maxLength={120} />
      </label>

      <AddressFields value={addr} onChange={setAddr} />

      <details className="more">
        <summary>Notes (optional)</summary>
        <label className="field">Notes
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} maxLength={4000} />
        </label>
      </details>

      {err && <p className="error" role="alert">{err}</p>}
      <button className="btn btn-primary btn-save" disabled={busy}>{busy ? 'Saving…' : visits ? 'Schedule quote' : 'Save and quote'}</button>
      {visits && <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => { if (check()) save(null, null); }}>Save without scheduling</button>}
    </form>
    {picking && (
      <ScheduleSheet title="When are you going to look at it?" who={name.trim()}
        bookings={bookings} confirmLabel="Schedule quote" onClose={() => setPicking(false)} onSave={save} />
    )}
    </>
  );
}
