import { useState } from 'react';
import { KINDS, KIND_LABEL, money } from '../../shared/quote.js';

const UNITS = ['ft', 'sq ft', 'each', 'hr', 'day', 'job', 'visit', 'sq', 'yd', 'load', 'ton', 'acre', 'tree'];
const cents = (v) => Math.round((parseFloat(String(v).replace(/[^0-9.]/g, '')) || 0) * 100);
const priceText = (c) => (c.kind === 'surcharge' ? `${c.unit_price_cents / 100}%` : c.kind === 'discount' ? `-${money(c.unit_price_cents)}` : money(c.unit_price_cents));

/** Owner setup: the services and prices that fill in quotes, plus the quote settings. Needs a connection. */
export default function PriceList({ data, snap, cfg, onBack }) {
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(null); // item id

  const run = async (fn) => {
    setErr(''); setBusy(true);
    try { await fn(); return true; } catch (e) { setErr(e.status === 0 || !snap.reachable ? 'This can only be changed while you have a connection.' : e.message); return false; } finally { setBusy(false); }
  };
  const groups = [...cfg.job_types.map((t) => ({ id: t.id, name: t.name })), { id: null, name: 'Any job' }]
    .map((g) => ({ ...g, items: cfg.catalog.filter((c) => (c.job_type_id ?? null) === g.id) })).filter((g) => g.items.length);

  return (
    <section>
      <button className="link back" onClick={onBack}>← Back</button>
      <h1>Prices and settings</h1>
      <p className="hint"><strong>Set these to your real prices.</strong> They fill in your quotes. Prices already on a sent quote never change.</p>
      {err && <p className="error" role="alert">{err}</p>}

      <Settings cfg={cfg} busy={busy} onSave={(f) => run(() => data.saveBusiness(f))} />


      {groups.map((g) => (
        <div key={g.id ?? 'any'}>
          <h2 className="qb-h">{g.name}</h2>
          <ul className="job-list">
            {g.items.map((c) => (editing === c.id
              ? <ItemForm key={c.id} cfg={cfg} item={c} busy={busy} onCancel={() => setEditing(null)} onDelete={() => run(async () => { await data.deleteCatalogItem(c.id); setEditing(null); })}
                  onSave={(v) => run(async () => { await data.saveCatalogItem({ ...v, id: c.id }); setEditing(null); })} />
              : (
                <li key={c.id} className="job pl-row">
                  <button className="pl-btn" onClick={() => setEditing(c.id)}>
                    <span className="pl-name">{c.name}{c.kind !== 'item' && <span className={`qtag qtag-${c.kind}`}>{KIND_LABEL[c.kind]}</span>}</span>
                    <span className="pl-price">{priceText(c)} {c.kind !== 'surcharge' && <small>/ {c.unit}</small>}</span>
                  </button>
                </li>
              )))}
          </ul>
        </div>
      ))}

      {adding
        ? <ItemForm cfg={cfg} busy={busy} onCancel={() => setAdding(false)} onSave={(v) => run(async () => { await data.saveCatalogItem(v); setAdding(false); })} />
        : <button className="btn btn-primary" onClick={() => setAdding(true)}>+ Add to price list</button>}
    </section>
  );
}

function Settings({ cfg, busy, onSave }) {
  const b = cfg.business;
  const [tax, setTax] = useState((b.tax_rate_bps / 100).toString());
  const [lic, setLic] = useState(b.license_no ?? '');
  const [min, setMin] = useState(b.min_charge_cents ? (b.min_charge_cents / 100).toFixed(2) : '');
  const [dep, setDep] = useState(String(b.default_deposit_pct ?? 50));
  const [days, setDays] = useState(String(b.valid_days ?? 30));
  const [visits, setVisits] = useState(b.uses_visits !== false);
  const [terms, setTerms] = useState(b.quote_terms ?? '');
  const [ok, setOk] = useState(false);
  const submit = (e) => {
    e.preventDefault(); setOk(false);
    onSave({
      tax_rate_bps: Math.round((parseFloat(tax) || 0) * 100), license_no: lic.trim() || null, min_charge_cents: cents(min),
      default_deposit_pct: Math.min(100, parseInt(dep, 10) || 0), valid_days: Math.min(365, Math.max(1, parseInt(days, 10) || 30)),
      uses_visits: visits, quote_terms: terms.trim() || null,
    }).then((r) => r && setOk(true));
  };
  return (
    <form className="panel" onSubmit={submit} aria-label="Quote settings">
      <h2 className="qb-h">Quote settings</h2>
      <label className="qb-check"><input type="checkbox" checked={visits} onChange={(e) => setVisits(e.target.checked)} />
        I visit the site before quoting (uses the Quote Scheduled step)</label>
      <div className="row">
        <label className="field">Sales tax (%)<input inputMode="decimal" value={tax} onChange={(e) => setTax(e.target.value.replace(/[^0-9.]/g, ''))} /></label>
        <label className="field">Minimum charge $<input inputMode="decimal" value={min} placeholder="0.00" onChange={(e) => setMin(e.target.value.replace(/[^0-9.]/g, ''))} /></label>
      </div>
      <div className="row">
        <label className="field">Usual deposit (%)<input inputMode="numeric" value={dep} onChange={(e) => setDep(e.target.value.replace(/\D/g, ''))} /></label>
        <label className="field">Quote good for (days)<input inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value.replace(/\D/g, ''))} /></label>
      </div>
      <label className="field">License number (shown on quotes)<input value={lic} maxLength={60} onChange={(e) => setLic(e.target.value)} placeholder="Optional" /></label>
      <label className="field">Terms on every quote
        <textarea rows={4} value={terms} maxLength={2000} onChange={(e) => setTerms(e.target.value)} placeholder="Warranty, cancellation, payment terms…" />
      </label>
      <p className="hint">A minimum charge is shown to the customer as its own line whenever it applies. Sales tax, fees and surcharges always appear on the quote.</p>
      <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save settings'}</button>
      {ok && <p className="hint" role="status">Saved.</p>}
    </form>
  );
}

function ItemForm({ cfg, item, busy, onSave, onCancel, onDelete }) {
  const [name, setName] = useState(item?.name ?? '');
  const [kind, setKind] = useState(item?.kind ?? 'item');
  const [unit, setUnit] = useState(item?.unit ?? 'each');
  const [price, setPrice] = useState(item ? (item.unit_price_cents / 100).toFixed(2) : '');
  const [cost, setCost] = useState(item?.unit_cost_cents != null ? (item.unit_cost_cents / 100).toFixed(2) : '');
  const [jt, setJt] = useState(item?.job_type_id ?? '');
  const [taxable, setTaxable] = useState(item?.taxable !== false);
  const [err, setErr] = useState('');
  const pct = kind === 'surcharge';
  const submit = (e) => {
    e.preventDefault();
    if (!name.trim()) return setErr('Enter a name.');
    if (!unit.trim() && !pct) return setErr('Enter a unit, like ft or each.');
    onSave({ name: name.trim(), kind, unit: pct ? '%' : unit.trim(), unit_price_cents: cents(price), unit_cost_cents: cost === '' || pct ? null : cents(cost), taxable, job_type_id: jt || null });
  };
  return (
    <form className="panel" onSubmit={submit}>
      <label className="field">Name<input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="6 ft cedar privacy fence" /></label>
      <label className="field">Type
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          {KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}{k === 'item' ? ' (materials or work)' : k === 'surcharge' ? ' (percent added)' : ''}</option>)}
        </select>
      </label>
      <div className="row">
        <label className="field">{pct ? 'Percent %' : 'Price $'}<input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="0.00" /></label>
        {!pct && (
          <label className="field">Per
            <input list="units" value={unit} onChange={(e) => setUnit(e.target.value)} maxLength={20} />
            <datalist id="units">{UNITS.map((u) => <option key={u} value={u} />)}</datalist>
          </label>
        )}
      </div>
      {!pct && (
        <label className="field priv">Your cost each $ <em>(only you see this, never shown to customers)</em>
          <input inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="optional" />
        </label>
      )}
      {!pct && <label className="qb-check"><input type="checkbox" checked={taxable} onChange={(e) => setTaxable(e.target.checked)} />Charge sales tax on this item</label>}
      <label className="field">Suggest for
        <select value={jt} onChange={(e) => setJt(e.target.value)}>
          <option value="">Every job type</option>
          {cfg.job_types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </label>
      {err && <p className="error" role="alert">{err}</p>}
      <div className="row">
        <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>
      </div>
      {onDelete && <button type="button" className="link" onClick={onDelete}>Remove this</button>}
    </form>
  );
}
