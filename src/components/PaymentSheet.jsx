import { useState } from 'react';
import { money } from '../../shared/quote.js';
import { todayStr } from '../format.js';

const METHODS = [['cash', 'Cash'], ['check', 'Check'], ['card', 'Card'], ['transfer', 'Zelle / Venmo'], ['other', 'Other']];
const toCents = (v) => Math.round((parseFloat(String(v).replace(/[^0-9.]/g, '')) || 0) * 100);

/** Record money received on a job. The amount starts at what is still owed. */
export default function PaymentSheet({ who, owed, onSave, onClose }) {
  const [amount, setAmount] = useState(owed > 0 ? (owed / 100).toFixed(2) : '');
  const [method, setMethod] = useState('cash');
  const [date, setDate] = useState(todayStr());
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const submit = (e) => {
    e.preventDefault();
    const cents = toCents(amount);
    if (cents < 1) { setErr('Enter how much you were paid.'); return; }
    if (!date) { setErr('Pick the date it came in.'); return; }
    onSave({ amountCents: cents, method, date, note: note.trim() || undefined });
  };
  return (
    <div className="sheet-back" onClick={onClose}>
      <form className="sheet" role="dialog" aria-modal="true" aria-label="Record a payment" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>Record a payment</h2>
        <p className="hint sheet-who">{who}{owed > 0 ? ` · ${money(owed)} still owed` : ''}</p>
        <label className="field">Amount received $
          <input inputMode="decimal" value={amount} placeholder="0.00" autoFocus onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))} />
        </label>
        <div className="method-row" role="group" aria-label="How they paid">
          {METHODS.map(([k, l]) => <button key={k} type="button" className={method === k ? 'on' : ''} aria-pressed={method === k} onClick={() => setMethod(k)}>{l}</button>)}
        </div>
        <label className="field">Date<input type="date" value={date} max={todayStr()} onChange={(e) => setDate(e.target.value)} /></label>
        <label className="field">Note (optional)<input value={note} maxLength={200} placeholder="Deposit, check #1042…" onChange={(e) => setNote(e.target.value)} /></label>
        {err && <p className="error" role="alert">{err}</p>}
        <div className="row">
          <button className="btn btn-primary">Save payment</button>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </div>
  );
}
