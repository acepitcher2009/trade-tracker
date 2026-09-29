import { Fragment, useEffect, useState } from 'react';
import { formatPhone } from '../../shared/phone.js';
import ScheduleSheet from '../components/ScheduleSheet.jsx';
import Kind from '../components/Kind.jsx';
import { dayLabel, todayStr, whenText } from '../format.js';
import { money } from '../../shared/quote.js';
import PaymentSheet from '../components/PaymentSheet.jsx';
import ConfirmSheet from '../components/ConfirmSheet.jsx';
import { EVERY_LABEL } from '../data.js';
import { followUpText, onMyWayText, quietDays, reminderText, smsLink } from '../texts.js';

const DATED = new Set(['visit', 'scheduled']); // stages that carry a date and time
// The big button on a card, by stage: [status it moves to, label, color].
const PRIMARY = {
  new: ['visit', 'Schedule visit', '#0891b2'],
  quoted: ['accepted', 'They said yes', '#db2777'],
  accepted: ['scheduled', 'Schedule job', '#1d4ed8'],
  scheduled: ['done', 'Mark done', '#15803d'],
  done: ['paid', 'Record payment', '#475569'],
};
const TARGET_TITLE = { visit: 'When are you going to look at it?', scheduled: 'When is the job?' };
const tomorrow = () => { const d = new Date(); d.setDate(d.getDate() + 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

const ago = (iso) => {
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  return d <= 0 ? 'today' : d === 1 ? 'yesterday' : d < 30 ? `${d} days ago` : new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

/**
 * Home screen: a job board (one tab per status) plus a search box that answers
 * "new or existing?" as you type a name, address or any part of a phone number.
 * Reads only the copy on this phone, so it is instant and works offline.
 */
export default function Board({ data, snap, cfg, terms, view, setView, onOpen, onAdd, onQuote }) {
  const noun = (terms.client || 'Client').toLowerCase();
  const nouns = (terms.clients || 'Clients');
  const { tab, q } = view;
  const [jobs, setJobs] = useState([]);
  const [found, setFound] = useState(null);
  const [sheet, setSheet] = useState(null); // { job, target } -> schedule picker (target = status to move to)
  const [news, setNews] = useState([]);
  const [nClients, setNClients] = useState(0);
  const [err, setErr] = useState('');
  const [payFor, setPayFor] = useState(null); // job -> payment sheet
  const [delFor, setDelFor] = useState(null); // job -> "delete this quote?" question

  // Re-read whenever local data changes (a tap, a sync) or the search text changes.
  useEffect(() => {
    let live = true;
    if (!snap.ready) return undefined;
    data.board().then((r) => live && setJobs(r));
    data.acceptances().then((r) => live && setNews(r));
    data.clientCount().then((n) => live && setNClients(n));
    data.search(q).then((r) => live && setFound({ q, rows: r }));
    return () => { live = false; };
  }, [data, snap.version, snap.ready, q]);

  const run = async (fn) => { setErr(''); try { await fn(); } catch (e) { setErr(e.message); } };

  if (!snap.ready) {
    return (
      <section>
        {snap.syncing || snap.reachable
          ? <div className="banner banner-wait" aria-busy="true">Downloading your {nouns.toLowerCase()}…</div>
          : <div className="banner banner-warn" role="alert">Connect to the internet once to download your {nouns.toLowerCase()}. After that, everything works with no signal.</div>}
      </section>
    );
  }

  const statuses = cfg.statuses;
  const usesVisits = cfg.business.uses_visits !== false;
  const searching = q.trim().length > 0;
  const today = todayStr();
  const byKey = (k) => jobs.filter((j) => j.status_key === k);
  const when = (x, y) => (x.scheduled_date || '9999').localeCompare(y.scheduled_date || '9999') || (x.scheduled_time || '99').localeCompare(y.scheduled_time || '99');
  const newestFirst = (x, y) => (x.updated_at < y.updated_at ? 1 : -1);
  const leads = byKey('new').sort(newestFirst);          // phone calls waiting for a site visit
  const visits = byKey('visit').sort(when);              // site visits booked
  const waiting = byKey('quoted').sort(newestFirst);     // quotes out, newest on top
  const toSchedule = byKey('accepted').sort(newestFirst); // said yes, need a job date
  const booked = byKey('scheduled').sort(when);          // jobs booked
  const toCollect = byKey('done').sort(newestFirst);     // finished, not paid
  const paidRecent = byKey('paid').sort(newestFirst).slice(0, 10);
  const owedOf = (list) => list.reduce((n, j) => n + (j.balance_cents ?? 0), 0);
  const monthKey = today.slice(0, 7);
  const collected = jobs.reduce((n, j) => n + (j.payments ?? []).filter((p) => p.date.startsWith(monthKey)).reduce((m, p) => m + p.amount_cents, 0), 0);
  const counts = (list) => {
    const d = list.filter((j) => j.scheduled_date);
    return { overdue: d.filter((j) => j.scheduled_date < today).length, today: d.filter((j) => j.scheduled_date === today).length };
  };
  const quoteDay = counts(visits);  // quotes to give (site visits)
  const jobDay = counts(booked);    // jobs to do
  const groupOf = (j) => (!j.scheduled_date ? 'No date yet' : j.scheduled_date < today ? 'Overdue' : dayLabel(j.scheduled_date));
  const advance = (j) => {
    if (j.status_key === 'new' && !usesVisits) { onQuote(j); return; }
    if (j.status_key === 'done') { setPayFor(j); return; }
    const [key] = PRIMARY[j.status_key] ?? [];
    const target = statuses.find((x) => x.key === key);
    if (!target) return;
    if (DATED.has(key)) setSheet({ job: j, target });
    else run(() => data.setStatus(j.id, target.id));
  };
  const card = (j) => <JobCard key={j.id} j={j} biz={cfg.business.name} usesVisits={usesVisits} today={today} onOpen={onOpen} onQuote={onQuote} advance={advance} setSheet={setSheet} onDelete={setDelFor} />;
  const sec = (title, n, tone) => <h2 className={`sec${tone ? ` sec-${tone}` : ''}`}>{title} <span className="daygroup-n">{n}</span></h2>;
  const byDay = (list) => list.map((j, i) => (
    <Fragment key={j.id}>
      {(i === 0 || groupOf(list[i - 1]) !== groupOf(j)) && (
        <h3 className={`daygroup${groupOf(j) === 'Overdue' ? ' daygroup-bad' : ''}`}>{groupOf(j)}</h3>
      )}
      {card(j)}
    </Fragment>
  ));
  const sumOf = (list) => list.filter((j) => j.quote_total_cents != null).reduce((n, j) => n + j.quote_total_cents, 0);
  const strip = (list, label) => list.length > 0 && (
    <div className="money" role="status">
      <span className="money-amt">{money(sumOf(list))}</span> <span className="money-label">{label}</span>
      {list.some((j) => j.quote_total_cents == null) && <span className="money-note">{list.filter((j) => j.quote_total_cents == null).length} without a quote amount</span>}
    </div>
  );
  const rows = found && found.q === q ? found.rows : null;
  const digits = q.replace(/\D/g, '');
  const bookings = jobs.filter((j) => j.status_key === 'scheduled' && j.scheduled_date)
    .map((j) => ({ id: j.id, date: j.scheduled_date, time: j.scheduled_time, name: j.client_name, type: j.job_type }));
  const exact = searching && rows && rows.length === 1 && digits.length === 10;

  return (
    <section>
      <h1 className="sr-only">{cfg.business.name} jobs</h1>
      <div className="searchbar">
        <input className="search" type="search" aria-label={`Search ${nouns.toLowerCase()} by name, address or phone`}
          placeholder="Search or add a client: name or phone" value={q} autoComplete="off"
          onChange={(e) => setView({ ...view, q: e.target.value })} />
      </div>
      {err && <p className="error" role="alert">{err}</p>}

      {searching ? (
        <div role="status" aria-live="polite">
          {exact && (rows[0].existing
            ? <div className="banner banner-existing"><div className="banner-title">EXISTING {noun.toUpperCase()}</div><div className="banner-jobs">Past customer, tap below to open.</div></div>
            : <div className="banner banner-new"><div className="banner-title">NEW {noun.toUpperCase()}</div><div className="banner-jobs">In your book, but no finished job yet.</div></div>)}
          {rows && rows.length > 0 && (
            <>
              {!exact && <p className="hint">{rows.length} existing {rows.length === 1 ? noun : nouns.toLowerCase()} — tap one:</p>}
              {rows.slice(0, 30).map((c) => <ClientRow key={c.id} c={c} onOpen={onOpen} />)}
              {!exact && (
                <button className="btn btn-ghost add-anyway" onClick={() => onAdd({ phone: digits.length >= 7 ? q : '', name: /[a-z]/i.test(q) ? q.trim() : '' })}>
                  Not them? Add “{q.trim()}” as a new {noun}
                </button>
              )}
            </>
          )}
          {rows && rows.length === 0 && (
            <div className="banner banner-new">
              <div className="banner-title">NEW {noun.toUpperCase()}</div>
              <div className="banner-jobs">Nobody matches “{q.trim()}”.</div>
              <button className="btn btn-light" onClick={() => onAdd({ phone: digits.length >= 7 ? q : '', name: /[a-z]/i.test(q) ? q.trim() : '' })}>
                Add {noun}
              </button>
            </div>
          )}
        </div>
      ) : (
        <>
          {news.length > 0 && (
            <div className="news" role="status">
              {news.slice(0, 3).map((n) => (
                <div key={n.job_id} className="news-item">
                  <div className="news-text"><strong>{n.name}</strong> {n.declined ? 'declined' : 'accepted'} your {n.total_cents != null ? `${money(n.total_cents)} ` : ''}quote</div>
                  <div className="news-sub">{n.declined ? (n.reason ? `“${n.reason}”` : 'No reason given.') : `${n.job_type}. Call them to schedule the job.`}</div>
                  <div className="news-actions">
                    <a className="btn btn-call" href={`tel:${n.phone_digits}`}>Call {n.client_name.split(' ')[0]}</a>
                    <button className="btn btn-call" onClick={() => { data.dismissAcceptances(); setView({ ...view, tab: n.declined ? 'quotes' : 'jobs' }); }}>See it</button>
                  </div>
                </div>
              ))}
              {news.length > 3 && <div className="news-sub">and {news.length - 3} more</div>}
              <button className="link" onClick={() => data.dismissAcceptances()}>Dismiss</button>
            </div>
          )}
          {tab !== 'estimates' && (quoteDay.today > 0 || quoteDay.overdue > 0) && (
            <button className="todaybar" onClick={() => setView({ ...view, tab: 'estimates' })}>
              <strong>Quotes</strong>
              {quoteDay.overdue > 0 && <span className="todaybar-bad">{quoteDay.overdue} overdue</span>}
              {quoteDay.today > 0 && <span>{quoteDay.today} on today’s schedule</span>}
              <span className="todaybar-go">View ›</span>
            </button>
          )}
          {tab !== 'jobs' && (jobDay.today > 0 || jobDay.overdue > 0) && (
            <button className="todaybar todaybar-jobs" onClick={() => setView({ ...view, tab: 'jobs' })}>
              <strong>Jobs</strong>
              {jobDay.overdue > 0 && <span className="todaybar-bad">{jobDay.overdue} overdue</span>}
              {jobDay.today > 0 && <span>{jobDay.today} on today’s schedule</span>}
              <span className="todaybar-go">View ›</span>
            </button>
          )}

          {tab === 'estimates' && (
            <>
              {leads.length > 0 && (
                <>
                  {sec('New calls: book a site visit', leads.length)}
                  {leads.map(card)}
                </>
              )}
              {visits.length > 0 && (
                <>
                  {sec('Site visits booked', visits.length)}
                  {byDay(visits)}
                </>
              )}
            </>
          )}

          {tab === 'quotes' && (
            <>
              {strip(waiting, 'waiting on an answer')}
              {waiting.map(card)}
            </>
          )}

          {tab === 'jobs' && (
            <>
              {toSchedule.length > 0 && (
                <>
                  {sec('Said yes: call and schedule', toSchedule.length, 'yes')}
                  {toSchedule.map(card)}
                </>
              )}
              {booked.length > 0 && (
                <>
                  {sec('Scheduled jobs', booked.length)}
                  {byDay(booked)}
                </>
              )}
            </>
          )}

          {tab === 'payments' && (
            <>
              <div className="moneyrow" role="status">
                <div><span className="money-amt">{money(sumOf(waiting))}</span><span className="money-label">quotes out</span></div>
                <div><span className="money-amt">{money(sumOf(toSchedule) + sumOf(booked))}</span><span className="money-label">won, not done</span></div>
                <div><span className="money-amt">{money(owedOf(toCollect))}</span><span className="money-label">to collect</span></div>
                <div><span className="money-amt">{money(collected)}</span><span className="money-label">collected this month</span></div>
              </div>
              {toCollect.length > 0 && (
                <>
                  {sec('Finished: collect payment', toCollect.length)}
                  {toCollect.map(card)}
                </>
              )}
              {paidRecent.length > 0 && (
                <>
                  {sec('Recently paid', paidRecent.length)}
                  {paidRecent.map(card)}
                </>
              )}
            </>
          )}

          {tab === 'clients' && (
            <>
              <div className="allhead"><h2>All {nouns.toLowerCase()} ({rows ? rows.length : '…'})</h2></div>
              {rows && rows.map((c) => <ClientRow key={c.id} c={c} onOpen={onOpen} />)}
            </>
          )}
        </>
      )}

      {payFor && (
        <PaymentSheet who={`${payFor.client_name} · ${payFor.job_type}`} owed={payFor.balance_cents ?? 0} onClose={() => setPayFor(null)}
          onSave={(p) => { const j = payFor; setPayFor(null); run(() => data.addPayment(j.id, p)); }} />
      )}
      {delFor && (
        <ConfirmSheet title="Delete this quote?" danger confirmLabel="Delete quote" cancelLabel="Keep it" onCancel={() => setDelFor(null)}
          onConfirm={() => { const j = delFor; setDelFor(null); run(() => data.deleteJob(j.id)); }}>
          This removes the {delFor.quote_total_cents != null ? `${money(delFor.quote_total_cents)} ` : ''}quote for {delFor.client_name}. {delFor.client_name.split(' ')[0]} stays in your clients. It can’t be undone.
        </ConfirmSheet>
      )}
      {sheet && (
        <ScheduleSheet
          title={sheet.target ? (TARGET_TITLE[sheet.target.key] ?? 'Pick a day') : (sheet.job.status_key === 'visit' ? 'Change visit time' : 'Change date')}
          who={`${sheet.job.client_name} · ${sheet.job.job_type}`}
          initialDate={sheet.job.scheduled_date} initialTime={sheet.job.scheduled_time}
          bookings={bookings} excludeJobId={sheet.job.id} assignedTo={sheet.job.assigned_to}
          confirmLabel={sheet.target ? 'Schedule' : 'Save'}
          onClose={() => setSheet(null)}
          onSave={(date, time) => {
            const { job, target } = sheet; setSheet(null);
            run(() => (target ? data.setStatus(job.id, target.id, { date, time }) : data.setSchedule(job.id, { date, time })));
          }}
          onClear={sheet.job.scheduled_date && !sheet.target ? () => { const { job } = sheet; setSheet(null); run(() => data.setSchedule(job.id, { date: null, time: null })); } : undefined}
        />
      )}
    </section>
  );
}

function ClientRow({ c, onOpen }) {
  return (
    <button className="clientrow" onClick={() => onOpen(c)}>
      <div className="jobcard-top">
        <span className="jobcard-name">{c.name}<Kind existing={c.existing} /></span>
        {c.last_job_status && <span className="mini-status" style={{ background: c.last_job_color }}>{c.last_job_status}</span>}
      </div>
      <div className="jobcard-line">{formatPhone(c.phone_digits)}{c.address ? ` · ${c.address}` : ''}</div>
      {c.booked_date && <div className="when">{c.booked_kind === 'visit' ? 'Site visit' : 'Job'} · {whenText({ scheduled_date: c.booked_date, scheduled_time: c.booked_time })}</div>}
      {!c.address_complete && <div className="addr-missing">Full address needed</div>}
      <div className="jobcard-line">
        {c.job_count === 0 ? 'No jobs yet' : `${c.job_count} job${c.job_count === 1 ? '' : 's'} · last: ${c.last_job_type}`}
        {c.pending && <span className="chip chip-dark chip-inline">Not synced</span>}
      </div>
    </button>
  );
}

// One job, wherever it is listed. The big button is always the next step for that stage.
function JobCard({ j, biz, usesVisits, today, onOpen, onQuote, advance, setSheet, onDelete }) {
  const p = PRIMARY[j.status_key];
  const dated = DATED.has(j.status_key);
  return (
    <article className="jobcard" style={{ borderLeftColor: j.status_color }}>
      <button className="jobcard-main" onClick={() => onOpen({ id: j.client_id })}>
        <div className="jobcard-top">
          <span className="jobcard-name">{j.client_name}<Kind existing={j.client_existing} /></span>
          <span className="mini-status" style={{ background: j.status_color }}>{j.status_label}</span>
        </div>
        <div className="jobcard-type">{j.job_type}{j.parent_job_id && <span className="qtag qtag-opt">Change order</span>}{j.pending && <span className="chip chip-dark chip-inline">Not synced</span>}</div>
        {j.quote_total_cents != null && (
          <div className="quote-line"><strong>{money(j.quote_total_cents)}</strong>
            {j.quote_accepted_at ? <span className="accepted">Accepted ✓</span> : j.quote?.sent_at ? <span className="sent">Sent {ago(j.quote.sent_at)}</span> : <span className="sent">Not sent yet</span>}
          </div>
        )}
        {j.declined_at && j.status_key === 'quoted' && <div className="declined">Declined{j.decline_reason ? `: ${j.decline_reason}` : ''}</div>}
        {j.paid_cents > 0 && j.quote_total_cents != null && <div className="paidline">Paid {money(j.paid_cents)} of {money(j.quote_total_cents)}</div>}
        {quietDays(j) >= 3 && !j.declined_at && <div className="when when-bad">No answer for {quietDays(j)} days. Time to follow up.</div>}
        {j.scheduled_date && <div className={`when${dated && j.scheduled_date < today ? ' when-bad' : ''}`}>{j.status_key === 'visit' ? 'Site visit · ' : ''}{whenText(j)}</div>}
        {(j.duration_days > 1 || j.assigned_to || j.recurrence) && <div className="jobcard-line">{[j.duration_days > 1 ? `${j.duration_days} days` : '', j.assigned_to, j.recurrence ? `Repeats ${EVERY_LABEL[j.recurrence.every]}` : ''].filter(Boolean).join(' · ')}</div>}
        {j.client_address && <div className="jobcard-line">{j.client_address}</div>}
        {!j.client_address_complete && <div className="addr-missing">Full address needed</div>}
        <div className="jobcard-line">{formatPhone(j.client_phone)}</div>
        {j.notes && <div className="jobcard-notes">{j.notes}</div>}
      </button>
      <div className="jobcard-actions">
        <a className="btn btn-call" href={`tel:${j.client_phone}`} aria-label={`Call ${j.client_name}`}>Call</a>
        {quietDays(j) >= 3 && !j.declined_at && <a className="btn btn-call" href={smsLink(j.client_phone, followUpText(j, biz))}>Follow up</a>}
        {dated && j.scheduled_date === today && <a className="btn btn-call" href={smsLink(j.client_phone, onMyWayText(j, biz))}>On my way</a>}
        {dated && j.scheduled_date > today && j.scheduled_date <= tomorrow() && <a className="btn btn-call" href={smsLink(j.client_phone, reminderText(j, biz))}>Remind</a>}
        {dated && <button className="btn btn-call" onClick={() => setSheet({ job: j })}>{j.scheduled_date ? 'Change date' : 'Set date'}</button>}
        {j.status_key === 'quoted' && j.quote && <button className="btn btn-call" onClick={() => onQuote(j)}>Quote</button>}
        {j.status_key === 'visit'
          ? <button className="btn btn-advance" style={{ background: '#b45309' }} onClick={() => onQuote(j)}>{!j.quote ? 'Quote it' : j.quote.sent_at ? 'Open quote' : 'Send quote'}</button>
          : j.status_key === 'new' && !usesVisits
            ? <button className="btn btn-advance" style={{ background: '#b45309' }} onClick={() => onQuote(j)}>{!j.quote ? 'Quote it' : 'Send quote'}</button>
            : p && <button className="btn btn-advance" style={{ background: p[2] }} onClick={() => advance(j)}>{p[1]}</button>}
      </div>
      {j.status_key === 'quoted' && <button type="button" className="link danger-link" onClick={() => onDelete(j)}>Delete quote</button>}
    </article>
  );
}
