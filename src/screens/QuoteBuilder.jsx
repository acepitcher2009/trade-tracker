import { useEffect, useMemo, useRef, useState } from 'react';
import { formatPhone } from '../../shared/phone.js';
import { computeQuote, money, profitOf, publicQuote, validateQuote } from '../../shared/quote.js';
import { addDays, dayOf, fmtDay, todayStr } from '../format.js';
import QuoteDocument from '../components/QuoteDocument.jsx';
import Measure from '../components/Measure.jsx';
import { tradeUi } from '../../shared/trades.js';
import { copyText } from '../clipboard.js';

const newToken = () => {
  const b = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const toCents = (v) => Math.round((parseFloat(String(v).replace(/[^0-9.]/g, '')) || 0) * 100);
const cur = (cents) => (cents / 100).toFixed(2);
// Unsaved edits are kept on this phone as a draft, so backing out, a dead battery or a reload never loses a quote in progress.
const draftKey = (jobId) => `tt_qdraft_${jobId}`;
const readDraft = (jobId) => { try { const v = JSON.parse(localStorage.getItem(draftKey(jobId)) || 'null'); return v && Array.isArray(v.items) ? v : null; } catch { return null; } };
const writeDraft = (jobId, v) => { try { localStorage.setItem(draftKey(jobId), JSON.stringify(v)); } catch { /* storage full or blocked: no draft, nothing else breaks */ } };
const clearDraft = (jobId) => { try { localStorage.removeItem(draftKey(jobId)); } catch { /* ignore */ } };

const KIND_ADD = [['labor', '+ Labor'], ['fee', '+ Fee'], ['allowance', '+ Allowance'], ['surcharge', '+ Surcharge %'], ['discount', '+ Discount']];
const KIND_NAME = { item: 'Item', labor: 'Labor', allowance: 'Allowance', fee: 'Fee', discount: 'Discount', surcharge: 'Surcharge' };
const NAME_HINT = { fee: 'Trip fee, permit, disposal…', discount: 'Repeat customer, senior…', surcharge: 'After hours, steep roof…', allowance: 'Tile allowance…', labor: 'Labor' };
const PKG_DEFAULT = [{ key: 'good', name: 'Good', blurb: '' }, { key: 'better', name: 'Better', blurb: '' }, { key: 'best', name: 'Best', blurb: '' }];
const STEPS_DEFAULT = [{ label: 'Deposit', pct: '30' }, { label: 'Halfway', pct: '40' }, { label: 'When finished', pct: '30' }];

let seq = 0;
const line = (o = {}) => ({ k: ++seq, id: `l${seq}`, name: '', unit: 'each', qty: '1', price: '0.00', kind: 'item', optional: false, group: '', note: '', cost: '', taxable: true, ...o });
const fromSaved = (it) => line({
  id: it.id, name: it.name, unit: it.unit, qty: String(it.qty), price: cur(it.unit_price_cents), kind: it.kind || 'item',
  optional: !!it.optional, group: it.group || '', note: it.note || '', cost: it.cost_cents != null ? cur(it.cost_cents) : '', taxable: it.taxable !== false,
});

/** Build an itemized quote for one job: tap services, set quantities, add fees or options, see the total, send it. */
export default function QuoteBuilder({ data, snap, cfg, clientId, jobId, onBack, onSent, onCopied, demo }) {
  const biz = cfg.business;
  const ui = tradeUi(biz.preset);
  const [client, setClient] = useState(null);
  const job = client?.jobs.find((j) => j.id === jobId);
  const [items, setItems] = useState(null);
  const [taxOn, setTaxOn] = useState(true);
  const [deposit, setDeposit] = useState(biz.default_deposit_pct ?? 50);
  const [plan, setPlan] = useState('deposit'); // 'deposit' | 'steps'
  const [steps, setSteps] = useState(STEPS_DEFAULT);
  const [validUntil, setValidUntil] = useState(addDays(todayStr(), biz.valid_days ?? 30));
  const [notes, setNotes] = useState('');
  const [scope, setScope] = useState('');
  const [exclusions, setExclusions] = useState('');
  const [internal, setInternal] = useState('');
  const [minCharge, setMinCharge] = useState(biz.min_charge_cents ? cur(biz.min_charge_cents) : '');
  const [showMath, setShowMath] = useState(true);
  const [packages, setPackages] = useState(null); // null = one price, or [{key,name,blurb}]
  const [token] = useState(() => newToken());
  const [showAll, setShowAll] = useState(false);
  const [open, setOpen] = useState(() => new Set()); // line keys with the details drawer open
  const [measuring, setMeasuring] = useState(null);
  const [saved, setSaved] = useState(false);
  const [preview, setPreview] = useState(false);
  const [previewSel, setPreviewSel] = useState(null);
  const [sendOpen, setSendOpen] = useState(false); // the "send it" pop-up
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [restored, setRestored] = useState(false);
  const [typeId, setTypeId] = useState(null); // the kind of job, chosen here (null = keep what the job already has)
  const dirty = useRef(false);
  const refs = useRef(new Map());
  const closeRef = useRef(null);
  const wasSent = useRef(null); // was the quote already sent when this screen opened?
  const tokenRef = useRef(null);

  useEffect(() => { data.getCard(clientId).then(setClient); }, [data, clientId, snap.version]);
  useEffect(() => {
    if (!sendOpen) return undefined;
    const k = (e) => e.key === 'Escape' && closeRef.current?.();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [sendOpen]);

  // Load an existing quote once the job is known.
  useEffect(() => {
    if (!job || items) return;
    const q = job.quote;
    if (q) {
      tokenRef.current = q.token;
      setItems(q.items.map(fromSaved));
      setTaxOn(q.tax_bps > 0); setDeposit(q.deposit_pct); setNotes(q.notes || '');
      setScope(q.scope || ''); setExclusions(q.exclusions || ''); setInternal(q.internal_notes || '');
      setMinCharge(q.min_charge_cents ? cur(q.min_charge_cents) : ''); setShowMath(q.show_unit_prices !== false);
      setPackages(q.packages ?? null);
      if (q.milestones?.length) { setPlan('steps'); setSteps(q.milestones.map((m) => ({ label: m.label, pct: String(m.pct) }))); }
      if (q.valid_until) setValidUntil(q.valid_until);
    } else {
      tokenRef.current = token; setItems([]); setTaxOn(biz.tax_rate_bps > 0);
    }
    const d = readDraft(job.id); // unsaved edits from last time win over what was saved
    if (d) {
      const top = Math.max(seq, ...d.items.map((x) => Number(String(x.id).replace(/\D/g, '')) || 0));
      seq = top;
      setItems(d.items.map((x) => ({ ...x, k: ++seq })));
      if (d.token) tokenRef.current = d.token;
      setTaxOn(!!d.taxOn); setDeposit(d.deposit ?? 50); setPlan(d.plan || 'deposit'); if (d.steps) setSteps(d.steps);
      setValidUntil(d.validUntil || ''); setNotes(d.notes || ''); setScope(d.scope || ''); setExclusions(d.exclusions || ''); setInternal(d.internal || '');
      setMinCharge(d.minCharge || ''); setShowMath(d.showMath !== false); setPackages(d.packages ?? null);
      dirty.current = true; setRestored(true);
    }
  }, [job, items, biz.tax_rate_bps, token]);

  // Keep a draft of anything not saved yet.
  useEffect(() => {
    if (!job || !items || saved || !dirty.current) return undefined;
    const t = setTimeout(() => writeDraft(job.id, { items, token: tokenRef.current, taxOn, deposit, plan, steps, validUntil, notes, scope, exclusions, internal, minCharge, showMath, packages }), 400);
    return () => clearTimeout(t);
  }, [job, items, saved, taxOn, deposit, plan, steps, validUntil, notes, scope, exclusions, internal, minCharge, showMath, packages]);

  const taxBps = taxOn ? biz.tax_rate_bps : 0;
  const draft = useMemo(() => {
    const pkKeys = new Set((packages ?? []).map((p) => p.key));
    const q = {
      token: tokenRef.current ?? token, tax_bps: taxBps, valid_until: validUntil || null, notes: notes || null,
      scope: scope || null, exclusions: exclusions || null, internal_notes: internal || null,
      sent_at: job?.quote?.sent_at ?? null,
      items: (items ?? []).map((it) => ({
        id: it.id, name: it.name, unit: it.unit || 'each', qty: parseFloat(it.qty) || 0,
        unit_price_cents: it.kind === 'surcharge' ? 0 : toCents(it.price), kind: it.kind,
        ...(it.optional ? { optional: true } : {}), ...(it.group && pkKeys.has(it.group) && !it.optional ? { group: it.group } : {}),
        ...(it.note ? { note: it.note } : {}), ...(it.taxable === false ? { taxable: false } : {}), ...(it.cost !== '' && it.kind !== 'surcharge' ? { cost_cents: toCents(it.cost) } : {}),
      })),
    };
    if (packages) q.packages = packages.map((p) => ({ key: p.key, name: p.name, blurb: p.blurb || null }));
    if (toCents(minCharge) > 0) q.min_charge_cents = toCents(minCharge);
    if (!showMath) q.show_unit_prices = false;
    if (plan === 'steps') q.milestones = steps.map((s) => ({ label: s.label, pct: parseInt(s.pct, 10) || 0 }));
    else q.deposit_pct = deposit;
    return q;
  }, [items, taxBps, deposit, plan, steps, validUntil, notes, scope, exclusions, internal, minCharge, showMath, packages, job, token]);
  const c = useMemo(() => computeQuote(draft), [draft]);
  const profit = useMemo(() => profitOf(draft), [draft]);
  const amountById = useMemo(() => new Map(c.lines.map((l) => [l.id, l])), [c]);
  const stepSum = steps.reduce((n, s) => n + (parseInt(s.pct, 10) || 0), 0);

  if (!client || !job || !items) return <section><button className="link back" onClick={onBack}>← Back</button><div className="banner banner-wait" aria-busy="true">Loading…</div></section>;

  const sent = !!job.quote?.sent_at;
  if (wasSent.current === null) wasSent.current = sent;
  // Leaving after sending a quote (any way out) lands on Quotes Sent, where that job lives now.
  const leave = () => (sent && !wasSent.current ? onSent?.() : onBack());
  // Closing the pop-up after the quote has gone out takes Deno to "Quotes Sent", where it now lives.
  const closeSend = () => { setSendOpen(false); if (sent) onSent?.(); };
  closeRef.current = closeSend;
  const effType = typeId ?? job.job_type_id ?? '';
  const typeName = cfg.job_types.find((t) => t.id === effType)?.name;
  const suggestions = cfg.catalog.filter((x) => showAll || !effType || !x.job_type_id || x.job_type_id === effType);
  const edited = () => { dirty.current = true; setSaved(false); };
  // This contractor's units: their trade's usual ones, then anything in their price list, then whatever this line already has.
  const unitsFor = (current) => [...new Set([...ui.units, ...cfg.catalog.map((c) => c.unit).filter((u) => u && u !== '%'), current].filter(Boolean))];
  const change = (k, patch) => { edited(); setItems((xs) => xs.map((x) => (x.k === k ? { ...x, ...patch } : x))); };
  const focusLine = (l) => setTimeout(() => refs.current.get(l.k)?.focus(), 30);
  const add = (cat) => {
    edited();
    const existing = cat && items.find((x) => x.name === cat.name);
    if (existing) { refs.current.get(existing.k)?.focus(); return; }
    const kind = cat?.kind || 'item';
    const l = cat
      ? line({
        name: cat.name, unit: kind === 'surcharge' ? '%' : cat.unit, kind,
        qty: kind === 'surcharge' ? String(cat.unit_price_cents / 100) : ['item', 'labor'].includes(kind) ? '' : '1',
        price: kind === 'surcharge' ? '0.00' : cur(cat.unit_price_cents), cost: cat.unit_cost_cents != null ? cur(cat.unit_cost_cents) : '', taxable: cat.taxable !== false,
      })
      : line({ qty: '1' });
    setItems((xs) => [...xs, l]);
    focusLine(l);
  };
  const addKind = (kind) => {
    edited();
    const l = line({ kind, qty: '1', unit: kind === 'surcharge' ? '%' : kind === 'labor' ? 'hr' : 'each' });
    setItems((xs) => [...xs, l]);
    focusLine(l);
  };
  const remove = (k) => { edited(); setItems((xs) => xs.filter((x) => x.k !== k)); };
  const toggleOpen = (k) => setOpen((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });

  const setPk = (i, patch) => { edited(); setPackages((ps) => ps.map((p, j) => (j === i ? { ...p, ...patch } : p))); };
  const togglePackages = (on) => {
    edited();
    if (on) setPackages(PKG_DEFAULT.map((p) => ({ ...p })));
    else { setPackages(null); setItems((xs) => xs.map((x) => ({ ...x, group: '' }))); }
  };

  const save = async (extra = {}) => {
    setErr('');
    if (!effType) { setErr('Pick what kind of job this is, near the top of the quote.'); window.scrollTo({ top: 0, behavior: 'smooth' }); return false; }
    const q = { ...draft, ...extra };
    const r = validateQuote(q);
    if (!r.ok) { setErr(r.error); return false; }
    try { await data.setQuote(job.id, r.value, effType); clearDraft(job.id); dirty.current = false; setRestored(false); setSaved(true); return true; } catch (e) { setErr(e.message); return false; }
  };
  // Tapping "Text it" opens the messages app; record the send and close this pop-up so it's gone when they come back.
  const markSent = async () => { if (await save({ sent_at: new Date().toISOString() })) { setSendOpen(false); onSent?.(); } };

  const link = `${window.location.origin}/?q=${tokenRef.current ?? token}`;
  const first = client.name.split(' ')[0];
  const lowest = packages ? Math.min(...packages.map((p) => computeQuote(draft, { package: p.key, options: [] }).total)) : c.total;
  const body = `Hi ${first}, here is your ${job.parent_job_id ? 'change order' : 'quote'} from ${biz.name}: ${packages ? `options from ${money(lowest)}` : money(c.total)}. View and accept it here: ${link}`;
  const offline = !snap.reachable || snap.pending > 0;
  const acceptedMsg = job.quote_accepted_at ? `Accepted by ${job.quote_accepted_by} on ${fmtDay(dayOf(job.quote_accepted_at))}. Changing the quote will ask ${first} to accept again.` : '';

  const copy = async () => {
    if (!(await save({ sent_at: new Date().toISOString() }))) return;
    const ok = await copyText(link);
    setSendOpen(false);
    onCopied?.(ok, link); // always back to the customer's page to text or call them
  };

  const safe = publicQuote(draft);
  const costLine = (it) => {
    if (it.cost === '' || it.kind === 'surcharge') return null;
    const l = amountById.get(it.id);
    if (!l || l.amount <= 0) return null;
    const cost = Math.round((parseFloat(it.qty) || 0) * toCents(it.cost));
    const m = l.amount - cost;
    return `${money(m)} profit (${Math.round((m / l.amount) * 100)}%)`;
  };

  return (
    <section className="qb">
      <button className="link back" onClick={leave}>← Back</button>
      <h1>{job.parent_job_id ? 'Change order' : 'Quote'} for {client.name}</h1>
      <p className="hint">{[typeName, client.address].filter(Boolean).join(' · ')}</p>
      {acceptedMsg && <div className="qdoc-stamp qdoc-ok" role="status">{acceptedMsg}</div>}
      {!saved && dirty.current && <p className="hint" role="status">{restored ? 'Picked up where you left off. ' : ''}Not saved yet. Your changes are kept on this phone until you save.</p>}

      <h2 className="qb-h">What kind of job is this?</h2>
      <div className="seg seg-wrap" role="group" aria-label="Kind of job">
        {cfg.job_types.map((t) => (
          <button key={t.id} type="button" className={effType === t.id ? 'on' : ''} aria-pressed={effType === t.id} onClick={() => { edited(); setTypeId(t.id); setErr(''); }}>{t.name}</button>
        ))}
      </div>
      {!effType && (/kind of job/.test(err)
        ? <p className="error" role="alert">Pick what kind of job this is first.</p>
        : <p className="hint">Pick one to see your matching services. It is saved with the quote.</p>)}

      <h2 className="qb-h">Add to the quote</h2>
      <div className="chips">
        {suggestions.map((x) => (
          <button key={x.id} type="button" className="chip-add" onClick={() => add(x)}>
            + {x.name}<span>{x.kind === 'surcharge' ? `${x.unit_price_cents / 100}% extra` : x.kind === 'discount' ? `${money(x.unit_price_cents)} off` : `${money(x.unit_price_cents)} / ${x.unit}`}</span>
          </button>
        ))}
        <button type="button" className="chip-add chip-custom" onClick={() => add(null)}>+ Custom line</button>
      </div>
      <div className="kinds" aria-label="Other kinds of lines">
        {KIND_ADD.filter(([k]) => ui.kinds.includes(k)).map(([k, l]) => <button key={k} type="button" className="kind-btn" onClick={() => addKind(k)}>{l}</button>)}
      </div>
      {cfg.catalog.length > suggestions.length && !showAll && <button className="link" onClick={() => setShowAll(true)}>Show all services</button>}
      {cfg.catalog.length === 0 && <p className="hint">No price list yet. Add your services under Prices, or use Custom line.</p>}

      <h2 className="qb-h">This quote</h2>
      {items.length === 0 && <p className="hint">Tap a service above to start.</p>}
      <ul className="qb-lines">
        {items.map((it, i) => {
          const l = amountById.get(it.id);
          const isOpen = open.has(it.k);
          const tag = it.optional ? 'Optional extra' : it.group ? (packages?.find((p) => p.key === it.group)?.name ?? '') : '';
          return (
            <li key={it.k} className={`qb-line qk-${it.kind}${it.optional ? ' qk-opt' : ''}`}>
              <div className="qb-row">
                <input aria-label={`Line ${i + 1} description`} className="qb-name" value={it.name} placeholder={NAME_HINT[it.kind] || 'Description'}
                  onChange={(e) => change(it.k, { name: e.target.value })} maxLength={120} />
                <button className="qb-x" aria-label={`Remove line ${i + 1}`} onClick={() => remove(it.k)}>✕</button>
              </div>
              {(it.kind !== 'item' || tag) && <div className="qb-tags">
                {it.kind !== 'item' && <span className={`qtag qtag-${it.kind}`}>{KIND_NAME[it.kind]}</span>}
                {tag && <span className="qtag qtag-opt">{tag}</span>}
              </div>}
              <div className="qb-row qb-math">
                <label>{it.kind === 'surcharge' ? 'Percent %' : 'Qty'}
                  <input ref={(el) => { if (el) refs.current.set(it.k, el); }} inputMode="decimal" value={it.qty} placeholder="0"
                    onChange={(e) => change(it.k, { qty: e.target.value.replace(/[^0-9.]/g, '') })} />
                </label>
                {it.kind !== 'surcharge' && <>
                  <label>Unit
                    {it.otherUnit
                      ? <input value={it.unit} autoFocus onChange={(e) => change(it.k, { unit: e.target.value })} maxLength={20} />
                      : (
                        <select value={it.unit} onChange={(e) => (e.target.value === '__other' ? change(it.k, { otherUnit: true, unit: '' }) : change(it.k, { unit: e.target.value }))}>
                          {unitsFor(it.unit).map((u) => <option key={u} value={u}>{u}</option>)}
                          <option value="__other">Other…</option>
                        </select>
                      )}
                  </label>
                  <label>Price $
                    <input inputMode="decimal" value={it.price} onChange={(e) => change(it.k, { price: e.target.value.replace(/[^0-9.]/g, '') })} />
                  </label>
                </>}
                <div className="qb-amt" aria-label="Line total">{money(l?.amount ?? 0)}</div>
              </div>
              <div className="qb-acts">
                {ui.measure.length > 0 && ['item', 'labor'].includes(it.kind) && <button type="button" className="link" onClick={() => setMeasuring(measuring === it.k ? null : it.k)}>Measure</button>}
                <button type="button" className="link" aria-expanded={isOpen} onClick={() => toggleOpen(it.k)}>{isOpen ? 'Hide options' : 'Options'}</button>
              </div>
              {measuring === it.k && <Measure modes={ui.measure} onClose={() => setMeasuring(null)} onUse={(n) => { change(it.k, { qty: String(n) }); setMeasuring(null); }} />}
              {isOpen && (
                <div className="qb-more">
                  <label className="qb-check"><input type="checkbox" checked={it.optional} onChange={(e) => change(it.k, { optional: e.target.checked, group: e.target.checked ? '' : it.group })} />
                    Optional extra (the customer chooses whether to add it)</label>
                  {packages && !it.optional && (
                    <label className="field">Included in
                      <select value={it.group} onChange={(e) => change(it.k, { group: e.target.value })}>
                        <option value="">Every package</option>
                        {packages.map((p) => <option key={p.key} value={p.key}>{p.name} only</option>)}
                      </select>
                    </label>
                  )}
                  {taxBps > 0 && (
                    <label className="qb-check"><input type="checkbox" checked={it.taxable} onChange={(e) => change(it.k, { taxable: e.target.checked })} />
                      Charge sales tax on this line</label>
                  )}
                  <label className="field">Note for the customer (optional)
                    <input value={it.note} maxLength={200} onChange={(e) => change(it.k, { note: e.target.value })} placeholder="Brand, size, what is covered…" />
                  </label>
                  {it.kind !== 'surcharge' && (
                    <label className="field priv">Your cost each $ <em>(only you see this)</em>
                      <input inputMode="decimal" value={it.cost} placeholder="optional" onChange={(e) => change(it.k, { cost: e.target.value.replace(/[^0-9.]/g, '') })} />
                      {costLine(it) && <span className="hint">{costLine(it)}</span>}
                    </label>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {c.minimumAdjustment > 0 && <p className="hint">Your minimum charge adds {money(c.minimumAdjustment)}. The customer sees it as its own line.</p>}

      {(ui.packages || packages) && <h2 className="qb-h">Good / Better / Best</h2>}
      {(ui.packages || packages) && <div className="qb-terms">
        <label className="qb-check"><input type="checkbox" checked={!!packages} onChange={(e) => togglePackages(e.target.checked)} />
          Offer more than one package</label>
        {packages && (
          <>
            <p className="hint">Give each package a name, then use Options on a line to say which package it belongs to. Lines set to "Every package" are in all of them.</p>
            {packages.map((p, i) => (
              <div key={p.key} className="qb-row pk-row">
                <input aria-label={`Package ${i + 1} name`} value={p.name} maxLength={30} onChange={(e) => setPk(i, { name: e.target.value })} />
                <input aria-label={`Package ${i + 1} description`} value={p.blurb} maxLength={120} placeholder="What makes it different" onChange={(e) => setPk(i, { blurb: e.target.value })} />
                <strong>{money(computeQuote(draft, { package: p.key, options: [] }).total)}</strong>
              </div>
            ))}
          </>
        )}
      </div>}

      <h2 className="qb-h">Details for the customer</h2>
      <div className="qb-terms">
        <label className="field">Scope of work (optional)
          <textarea rows={4} value={scope} maxLength={4000} onChange={(e) => { edited(); setScope(e.target.value); }} placeholder="What you will do, step by step…" />
        </label>
        <label className="field">Not included (optional)
          <textarea rows={3} value={exclusions} maxLength={2000} onChange={(e) => { edited(); setExclusions(e.target.value); }} placeholder="Permits, painting, hidden damage, anything beyond the scope…" />
        </label>
        <label className="field">Notes for the client (optional)
          <textarea rows={3} value={notes} maxLength={2000} onChange={(e) => { edited(); setNotes(e.target.value); }} placeholder="Start date, materials, warranty…" />
        </label>
      </div>

      <h2 className="qb-h">Payment and terms</h2>
      <div className="qb-terms">
        <div className="qb-opt">
          <span>Payments</span>
          <div className="seg">
            <button type="button" className={plan === 'deposit' ? 'on' : ''} aria-pressed={plan === 'deposit'} onClick={() => { edited(); setPlan('deposit'); }}>Deposit</button>
            <button type="button" className={plan === 'steps' ? 'on' : ''} aria-pressed={plan === 'steps'} onClick={() => { edited(); setPlan('steps'); }}>In steps</button>
          </div>
        </div>
        {plan === 'deposit' ? (
          <div className="qb-opt">
            <span>Deposit</span>
            <div className="seg">{[...new Set([0, 25, 33, 50, deposit])].sort((a, b) => a - b).map((p) => <button key={p} type="button" className={deposit === p ? 'on' : ''} aria-pressed={deposit === p} onClick={() => { edited(); setDeposit(p); }}>{p === 0 ? 'None' : `${p}%`}</button>)}</div>
          </div>
        ) : (
          <div className="steps">
            {steps.map((s, i) => (
              <div key={i} className="qb-row pk-row">
                <input aria-label={`Payment ${i + 1} name`} value={s.label} maxLength={40} onChange={(e) => { edited(); setSteps((xs) => xs.map((x, j) => (j === i ? { ...x, label: e.target.value } : x))); }} />
                <input aria-label={`Payment ${i + 1} percent`} className="pct" inputMode="numeric" value={s.pct} onChange={(e) => { edited(); setSteps((xs) => xs.map((x, j) => (j === i ? { ...x, pct: e.target.value.replace(/\D/g, '') } : x))); }} />
                <span>%</span>
                <strong>{money(c.schedule[i]?.amount ?? 0)}</strong>
                {steps.length > 2 && <button type="button" className="qb-x" aria-label={`Remove payment ${i + 1}`} onClick={() => { edited(); setSteps((xs) => xs.filter((_, j) => j !== i)); }}>✕</button>}
              </div>
            ))}
            {steps.length < 6 && <button type="button" className="link" onClick={() => { edited(); setSteps((xs) => [...xs, { label: 'Payment', pct: '0' }]); }}>+ Add a payment</button>}
            <p className={stepSum === 100 ? 'hint' : 'error'} role={stepSum === 100 ? undefined : 'alert'}>{stepSum === 100 ? 'Adds up to 100%.' : `Adds up to ${stepSum}%. It must be 100%.`}</p>
          </div>
        )}
        <div className="qb-opt">
          <span>Good for</span>
          <div className="seg">{[14, 30, 60, 90].map((d) => <button key={d} type="button" className={validUntil === addDays(todayStr(), d) ? 'on' : ''} aria-pressed={validUntil === addDays(todayStr(), d)} onClick={() => { edited(); setValidUntil(addDays(todayStr(), d)); }}>{d} days</button>)}</div>
        </div>
        <label className="field">Minimum charge $ (optional)
          <input inputMode="decimal" value={minCharge} placeholder="0.00" onChange={(e) => { edited(); setMinCharge(e.target.value.replace(/[^0-9.]/g, '')); }} />
        </label>
        {biz.tax_rate_bps > 0 && (
          <label className="qb-check"><input type="checkbox" checked={taxOn} onChange={(e) => { edited(); setTaxOn(e.target.checked); }} />
            Charge sales tax ({(biz.tax_rate_bps / 100).toFixed(2)}%)</label>
        )}
        <label className="qb-check"><input type="checkbox" checked={showMath} onChange={(e) => { edited(); setShowMath(e.target.checked); }} />
          Show quantity × price on each line (turn off to show just the line amounts)</label>
      </div>

      <h2 className="qb-h">Only you see this</h2>
      <div className="qb-terms priv-box">
        <label className="field">Private notes
          <textarea rows={2} value={internal} maxLength={2000} onChange={(e) => { edited(); setInternal(e.target.value); }} placeholder="Gate code, sub's price, reminders…" />
        </label>
        {profit.known
          ? <p className="profit"><strong>{money(profit.margin)} profit</strong> on lines with a cost ({profit.pct}%). Your costs and profit never appear on the customer's quote.</p>
          : <p className="hint">Add "Your cost" under a line's Options to see your profit here. Your costs never appear on the customer's quote.</p>}
      </div>

      {err && !/kind of job/.test(err) && <p className="error" role="alert">{err}</p>}

      {sendOpen && (
        <div className="sheet-back" onClick={closeSend}>
          <div className="sheet send" role="dialog" aria-modal="true" aria-label={`Send quote to ${first}`} onClick={(e) => e.stopPropagation()}>
            <h2>{sent ? 'Quote sent ✓' : 'Quote saved. Not sent yet.'}</h2>
            <p className="send-total">{packages ? `From ${money(lowest)}` : money(c.total)}{!packages && c.deposit > 0 && <span> · {money(c.deposit)} {plan === 'steps' ? 'first payment' : 'deposit'}</span>}</p>
            <p className="hint sheet-who">{sent
              ? `${client.name} has the link. It moves to Quotes Sent until they answer.`
              : `It stays under Quote Scheduled until you send it to ${client.name}. Tap a button below.`}</p>
            {offline && <p className="hint">This phone hasn't synced yet. The link starts working as soon as it does.</p>}
            {demo
              ? <button className="btn btn-primary" onClick={markSent}>Pretend to text it (nothing is sent)</button>
              : <a className="btn btn-primary btn-link" href={`sms:+1${client.phone_digits}?&body=${encodeURIComponent(body)}`} onClick={markSent}>Text it to {formatPhone(client.phone_digits)}</a>}
            {!demo && <button className="btn btn-ghost" onClick={copy}>Copy link</button>}
            <button className="btn btn-ghost sheet-gap" onClick={() => setPreview((p) => !p)}>{preview ? 'Hide preview' : 'Preview what they see'}</button>
            {msg && <p className="hint" aria-live="polite">{msg}</p>}
            {preview && (
              <div className="preview-wrap">
                <QuoteDocument business={biz} client={{ name: client.name, address: client.address }} jobType={typeName ?? job.job_type}
                  quote={safe} selection={previewSel ?? undefined} onSelect={setPreviewSel}
                  acceptedAt={job.quote_accepted_at} acceptedBy={job.quote_accepted_by} changeOrder={!!job.parent_job_id} />
                <button className="btn btn-ghost no-print" onClick={() => window.print()}>Print or save as PDF</button>
              </div>
            )}
            <button className="link sheet-cancel" onClick={closeSend}>{sent ? 'Done' : 'Close, send later'}</button>
          </div>
        </div>
      )}

      <div className="qbar">
        <div className="qbar-total"><span>{packages ? `Total (${packages.find((p) => p.key === c.selection.package)?.name})` : 'Total'}</span><strong>{money(c.total)}</strong>{c.deposit > 0 && <small>{money(c.deposit)} {plan === 'steps' ? 'first payment' : 'deposit'}</small>}</div>
        <button className="btn btn-primary" disabled={items.length === 0}
          onClick={async () => { if (saved || (await save())) setSendOpen(true); }}>{saved ? 'Send to client' : 'Save and send'}</button>
      </div>
    </section>
  );
}
