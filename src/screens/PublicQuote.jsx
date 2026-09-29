import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { computeQuote, defaultSelection, money } from '../../shared/quote.js';
import QuoteDocument from '../components/QuoteDocument.jsx';

/** What the client opens from the text message: their quote, and a way to accept it. No sign-in. */
export default function PublicQuote({ token }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState(null);
  const [agree, setAgree] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');

  useEffect(() => {
    api.publicQuote(token).then((d) => {
      setData(d);
      setSel(defaultSelection(d.quote));
      document.title = `Quote from ${d.business.name}`;
      if (d.business.accent_color) document.documentElement.style.setProperty('--accent', d.business.accent_color);
    }).catch((e) => setErr(e.status === 404 ? 'This quote link is not valid. Please ask the business for a new one.' : e.message));
  }, [token]);

  const accept = async (e) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try { setData(await api.acceptQuote(token, name, sel, agree)); } catch (ex) { setErr(ex.message); } finally { setBusy(false); }
  };

  const decline = async (e) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try { setData(await api.declineQuote(token, reason.trim())); setDeclining(false); } catch (ex) { setErr(ex.message); } finally { setBusy(false); }
  };

  if (!data) {
    return <main className="boot" aria-busy={!err}>{err ? <span className="error" role="alert">{err}</span> : 'Loading your quote…'}</main>;
  }
  const accepted = !!data.accepted_at;
  const declined = !!data.declined_at && !accepted;
  const shown = accepted ? data.selection ?? sel : sel;
  const total = computeQuote(data.quote, shown).total;
  return (
    <main className="qpage">
      <QuoteDocument business={data.business} client={data.client} jobType={data.job_type} quote={data.quote} selection={shown}
        onSelect={accepted || data.expired ? undefined : setSel} acceptedAt={data.accepted_at} acceptedBy={data.accepted_by}
        expired={data.expired} changeOrder={data.change_order} />
      {!accepted && !data.expired && !declined && (
        <form className="qaccept no-print" onSubmit={accept}>
          <h2>Ready to go?</h2>
          <label className="field">Type your full name to accept this {data.change_order ? 'change order' : 'quote'}
            <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" autoCapitalize="words" maxLength={120} placeholder="Your full name" />
          </label>
          <label className="qb-check"><input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
            I agree to the price, the work described{data.business.quote_terms ? ', and the terms' : ''} on this page.</label>
          {err && <p className="error" role="alert">{err}</p>}
          <button className="btn btn-primary" disabled={busy || !agree || name.trim().length < 2}>{busy ? 'Accepting…' : `Accept for ${money(total)}`}</button>
          <p className="hint">Accepting lets {data.business.name} know you'd like to move forward with the choices shown above. They'll contact you to schedule.</p>
        </form>
      )}
      {!accepted && !data.expired && !declined && (
        <div className="qdecline no-print">
          {!declining
            ? <button type="button" className="btn btn-ghost" onClick={() => setDeclining(true)}>No thanks, decline this {data.change_order ? 'change order' : 'quote'}</button>
            : (
              <form className="qaccept" onSubmit={decline}>
                <h2>Not this time?</h2>
                <label className="field">Tell {data.business.name} why (optional)
                  <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="Price, timing, went another way…" />
                </label>
                {err && <p className="error" role="alert">{err}</p>}
                <button className="btn btn-primary" disabled={busy}>{busy ? 'Sending…' : 'Decline the quote'}</button>
                <button type="button" className="btn btn-ghost" onClick={() => setDeclining(false)}>Go back</button>
              </form>
            )}
        </div>
      )}
      {declined && (
        <p className="banner banner-wait no-print" role="status">You declined this quote. {data.business.name} has been told. Changed your mind? Call {data.business.name} and they can send an updated quote.</p>
      )}
      {accepted && (
        <p className="banner banner-existing no-print" role="status">Thank you! {data.business.name} has been notified and will contact you to schedule.</p>
      )}
      <button className="btn btn-ghost no-print" onClick={() => window.print()}>Print or save as PDF</button>
    </main>
  );
}
