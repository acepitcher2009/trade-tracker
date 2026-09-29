import { formatPhone } from '../../shared/phone.js';
import { computeQuote, defaultSelection, money } from '../../shared/quote.js';
import { dayOf, fmtDay } from '../format.js';

const pct = (bps) => (bps / 100).toFixed(2).replace(/\.?0+$/, '');
const KIND_TAG = { fee: 'Fee', discount: 'Discount', surcharge: 'Surcharge', allowance: 'Allowance', labor: 'Labor' };

/**
 * The itemized quote as the customer sees it (in-app preview, public page, printing).
 * `quote` must already be the customer-safe shape (see publicQuote): no unit costs, no private notes.
 * Pass `onSelect` to let the reader pick a package / toggle optional extras; leave it off for a read-only view.
 */
export default function QuoteDocument({ business, client, jobType, quote, selection, onSelect, acceptedAt, acceptedBy, expired, changeOrder }) {
  const sel = selection ?? defaultSelection(quote);
  const c = computeQuote(quote, sel);
  const editable = !!onSelect && !acceptedAt && !expired;
  const pk = quote.packages ?? [];
  const showMath = quote.show_unit_prices !== false;
  const fixed = c.lines.filter((l) => !l.optional && (!l.group || l.group === c.selection.package) && l.included);
  const extras = c.lines.filter((l) => l.optional && (editable || l.included));
  const pkgTotal = (key) => computeQuote(quote, { package: key, options: c.selection.options }).total;
  const toggle = (id) => {
    const on = c.selection.options.includes(id);
    onSelect({ ...c.selection, options: on ? c.selection.options.filter((x) => x !== id) : [...c.selection.options, id] });
  };
  const shownPk = acceptedAt ? pk.filter((p) => p.key === c.selection.package) : pk;

  return (
    <article className="qdoc" aria-label="Quote">
      <header className="qdoc-head" style={{ background: business.accent_color || 'var(--accent)' }}>
        <div className="qdoc-biz">{business.name}</div>
        <div className="qdoc-sub">
          {business.phone_digits ? formatPhone(business.phone_digits) : ''}
          {business.city ? `${business.phone_digits ? ' · ' : ''}${business.city}, ${business.state ?? ''}` : ''}
        </div>
        {business.license_no && <div className="qdoc-sub">License {business.license_no}</div>}
      </header>
      <div className="qdoc-body">
        <div className="qdoc-title">{changeOrder ? 'Change order' : 'Quote'} · {jobType}</div>
        <div className="qdoc-for">
          <span className="detail-label">Prepared for</span>
          <strong>{client.name}</strong>
          {client.address && <div>{client.address}</div>}
        </div>
        {acceptedAt && <div className="qdoc-stamp qdoc-ok" role="status">Accepted by {acceptedBy} on {fmtDay(dayOf(acceptedAt))}</div>}
        {expired && <div className="qdoc-stamp qdoc-bad" role="status">This quote expired on {fmtDay(quote.valid_until)}.</div>}

        {quote.scope && (
          <section className="qsec">
            <h3>Scope of work</h3>
            <p className="qtext">{quote.scope}</p>
          </section>
        )}

        {shownPk.length > 0 && (
          <section className="qsec" aria-label="Choose an option">
            {!acceptedAt && <h3>Choose your option</h3>}
            <div className="pkgs" role={editable ? 'radiogroup' : undefined}>
              {shownPk.map((p) => (
                <button key={p.key} type="button" role={editable ? 'radio' : undefined} aria-checked={editable ? c.selection.package === p.key : undefined}
                  className={`pkg${c.selection.package === p.key ? ' on' : ''}`} disabled={!editable}
                  onClick={() => editable && onSelect({ ...c.selection, package: p.key })}>
                  <span className="pkg-name">{p.name}</span>
                  <span className="pkg-price">{money(pkgTotal(p.key))}</span>
                  {p.blurb && <span className="pkg-blurb">{p.blurb}</span>}
                </button>
              ))}
            </div>
          </section>
        )}

        <ul className="qlines">
          {fixed.map((l) => (
            <li key={l.id} className="qline">
              <div className="qline-name">{l.name}{KIND_TAG[l.kind] && l.kind !== 'labor' && <span className={`qtag qtag-${l.kind}`}>{KIND_TAG[l.kind]}</span>}</div>
              <div className="qline-math">
                {l.kind === 'surcharge' ? `${l.qty}% of the work above`
                  : showMath ? `${l.qty} ${l.unit} × ${money(l.unit_price_cents)}` : `${l.qty} ${l.unit}`}
                {l.note ? ` · ${l.note}` : ''}
              </div>
              <div className="qline-amt">{money(l.amount)}</div>
            </li>
          ))}
          {c.minimumAdjustment > 0 && (
            <li className="qline">
              <div className="qline-name">Minimum service charge<span className="qtag qtag-fee">Fee</span></div>
              <div className="qline-math">Brings the work to our {money(quote.min_charge_cents)} minimum</div>
              <div className="qline-amt">{money(c.minimumAdjustment)}</div>
            </li>
          )}
        </ul>

        {extras.length > 0 && (
          <section className="qsec" aria-label="Optional extras">
            <h3>{editable ? 'Optional extras' : 'Extras you chose'}</h3>
            {editable && <p className="hint">Tick anything you want added. It is not in the total until you do.</p>}
            <ul className="qlines">
              {extras.map((l) => (
                <li key={l.id} className="qline qopt">
                  <label className="qopt-l">
                    {editable && <input type="checkbox" checked={l.included} onChange={() => toggle(l.id)} />}
                    <span><span className="qline-name">{l.name}</span>
                      <span className="qline-math"> {l.kind === 'surcharge' ? `${l.qty}% of the work` : showMath ? `${l.qty} ${l.unit} × ${money(l.unit_price_cents)}` : `${l.qty} ${l.unit}`}{l.note ? ` · ${l.note}` : ''}</span></span>
                  </label>
                  <div className="qline-amt">{l.amount < 0 ? '' : '+'}{money(l.amount)}</div>
                </li>
              ))}
            </ul>
          </section>
        )}

        <dl className="qtotals">
          <div><dt>Subtotal</dt><dd>{money(c.subtotal)}</dd></div>
          {quote.tax_bps > 0 && <div><dt>Sales tax ({pct(quote.tax_bps)}%{c.taxableBase !== c.subtotal ? ` on ${money(c.taxableBase)}` : ''})</dt><dd>{money(c.tax)}</dd></div>}
          <div className="qtotal"><dt>Total</dt><dd>{money(c.total)}</dd></div>
        </dl>

        {c.total > 0 && (
          <section className="qsec" aria-label="Payment schedule">
            <h3>How payment works</h3>
            <ul className="qsched">
              {c.schedule.map((s, i) => (
                <li key={i}><span>{s.label}{c.schedule.length > 1 ? ` (${s.pct}%)` : ''}</span><strong>{money(s.amount)}</strong></li>
              ))}
            </ul>
          </section>
        )}

        {quote.exclusions && (
          <section className="qsec">
            <h3>Not included</h3>
            <p className="qtext">{quote.exclusions}</p>
          </section>
        )}
        {quote.notes && <p className="qnotes">{quote.notes}</p>}
        {business.quote_terms && (
          <section className="qsec">
            <h3>Terms</h3>
            <p className="qtext qfine">{business.quote_terms}</p>
          </section>
        )}
        {quote.valid_until && !expired && <p className="qvalid">Good until {fmtDay(quote.valid_until)}.</p>}
      </div>
    </article>
  );
}
