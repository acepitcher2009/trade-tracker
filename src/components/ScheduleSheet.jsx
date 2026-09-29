import { useEffect, useMemo, useRef, useState } from 'react';
import { dayLabel, fmtTime, toDateStr, todayStr } from '../format.js';

const DOW = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
// Start times: every 30 minutes, 6:00 AM to 8:00 PM.
const SLOTS = Array.from({ length: 29 }, (_, i) => { const m = 6 * 60 + i * 30; return `${String(Math.floor(m / 60)).padStart(2, '0')}:${m % 60 ? '30' : '00'}`; });

/**
 * Pop-up calendar for booking a job. Days that already have jobs show a count, and tapping a day lists
 * who is booked and when, so Deno can see the day is full before he picks it. A same-time clash is flagged.
 * `bookings` = [{ id, date, time, name, type }] for every currently scheduled job; `excludeJobId` is this job.
 */
export default function ScheduleSheet({ title, who, initialDate, initialTime, assignedTo, bookings = [], excludeJobId, confirmLabel = 'Schedule', onSave, onClear, onClose }) {
  const t = todayStr();
  const start = initialDate && initialDate >= t ? initialDate : t; // no booking in the past: an overdue job starts from today
  const [date, setDate] = useState(start);
  const [time, setTime] = useState(initialTime || ''); // required: no default, Deno must pick a slot
  const [month, setMonth] = useState(() => { const d = new Date(`${start}T12:00:00`); return { y: d.getFullYear(), m: d.getMonth() }; });
  const focus = useRef(null);
  useEffect(() => { focus.current?.focus(); }, []);
  useEffect(() => {
    const k = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);

  const byDate = useMemo(() => {
    const m = new Map();
    for (const b of bookings) {
      if (b.id === excludeJobId) continue;
      if (!m.has(b.date)) m.set(b.date, []);
      m.get(b.date).push(b);
    }
    for (const list of m.values()) list.sort((a, b) => (a.time || '99').localeCompare(b.time || '99'));
    return m;
  }, [bookings, excludeJobId]);

  const first = new Date(month.y, month.m, 1);
  const daysIn = new Date(month.y, month.m + 1, 0).getDate();
  const cells = [...Array(first.getDay()).fill(null), ...Array.from({ length: daysIn }, (_, i) => toDateStr(new Date(month.y, month.m, i + 1)))];
  const shift = (n) => setMonth(({ y, m }) => { const d = new Date(y, m + n, 1); return { y: d.getFullYear(), m: d.getMonth() }; });
  const monthName = first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  const day = byDate.get(date) ?? [];
  const slots = time && !SLOTS.includes(time) ? [...SLOTS, time].sort() : SLOTS;
  // A clash is the same start time for the same crew. Different crews (or an unassigned job) can run side by side.
  const sameCrew = (b) => !b.crew || !assignedTo || b.crew === assignedTo;
  const clash = time ? day.find((b) => b.time === time && sameCrew(b)) : null;
  const busy = day.length > 0;

  return (
    <div className="sheet-back" onClick={onClose}>
      <div className="sheet sheet-cal" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        {who && <p className="hint sheet-who">{who}</p>}

        <div className="cal-head">
          <button type="button" className="cal-nav" aria-label="Previous month" onClick={() => shift(-1)}>‹</button>
          <div className="cal-month" aria-live="polite">{monthName}</div>
          <button type="button" className="cal-nav" aria-label="Next month" onClick={() => shift(1)}>›</button>
        </div>
        <div className="cal-grid" role="grid" aria-label={monthName}>
          {DOW.map((d, i) => <div key={i} className="cal-dow" aria-hidden="true">{d}</div>)}
          {cells.map((d, i) => {
            if (!d) return <div key={`b${i}`} />;
            const n = byDate.get(d)?.length ?? 0;
            const cls = ['cal-day', d === date && 'sel', d === t && 'today', d < t && 'past', n > 0 && 'has', n >= 3 && 'full'].filter(Boolean).join(' ');
            return (
              <button key={d} type="button" ref={d === date ? focus : null} className={cls} aria-pressed={d === date} disabled={d < t}
                aria-label={`${dayLabel(d)}${n ? `, ${n} booked` : ', open'}`} onClick={() => setDate(d)}>
                <span>{Number(d.slice(8))}</span>
                {n > 0 && <span className="cal-n">{n}</span>}
              </button>
            );
          })}
        </div>

        <div className={`daybox${busy ? ' daybox-busy' : ''}`} role="status" aria-live="polite">
          <div className="daybox-title">{dayLabel(date)} — {busy ? `${day.length} already booked` : 'open day'}</div>
          {day.map((b) => (
            <div key={b.id} className="daybox-row">
              <span className="daybox-time">{b.time ? fmtTime(b.time) : 'Any time'}</span>
              <span>{b.name} · {b.type}</span>
            </div>
          ))}
        </div>

        <fieldset className="slots-wrap">
          <legend>Start time <span className="req">(required)</span></legend>
          <div className="slots">
            {slots.map((sl) => {
              const who = day.filter((x) => x.time === sl && sameCrew(x));
              return (
                <button key={sl} type="button" className={`slot${time === sl ? ' on' : ''}${who.length ? ' taken' : ''}`}
                  aria-pressed={time === sl} title={who.length ? `Booked: ${who.map((x) => x.name).join(', ')}` : undefined}
                  aria-label={`${fmtTime(sl)}${who.length ? `, booked by ${who.map((x) => x.name).join(', ')}` : ', open'}`}
                  onClick={() => setTime(sl)}>
                  {fmtTime(sl)}
                  {who.length > 0 && <span className="slot-who">{who[0].name.split(' ')[0]}</span>}
                </button>
              );
            })}
          </div>
        </fieldset>
        {clash && <p className="error" role="alert">Clash: {clash.name} is already booked at {fmtTime(time)}.</p>}

        <button className={`btn ${clash ? 'btn-warn' : 'btn-primary'}`} disabled={!time} onClick={() => onSave(date, time)}>
          {!time ? 'Pick a start time' : `${clash ? 'Book anyway' : confirmLabel}: ${dayLabel(date)} · ${fmtTime(time)}`}
        </button>
        {onClear && <button className="btn btn-ghost sheet-gap" onClick={onClear}>Remove date</button>}
        <button className="link sheet-cancel" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}
