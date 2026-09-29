export const fmtDate = (iso) =>
  new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
export const jobsText = (n) => (n === 0 ? 'No jobs yet' : `${n} job${n === 1 ? '' : 's'}`);

// ---- dates for scheduling (all local-time, 'YYYY-MM-DD' strings) ----
const pad = (n) => String(n).padStart(2, '0');
export const toDateStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const todayStr = () => toDateStr(new Date());
/** The calendar day (in the viewer's own time zone) of a timestamp such as '2026-09-29T02:30:00Z'. Never slice the string: that is the UTC day. */
export const dayOf = (iso) => toDateStr(new Date(iso));
export const addDays = (s, n) => { const d = new Date(`${s}T12:00:00`); d.setDate(d.getDate() + n); return toDateStr(d); };
export const nextMonday = (s) => { const d = new Date(`${s}T12:00:00`); return addDays(s, ((8 - d.getDay()) % 7) || 7); };
export function dayLabel(s) {
  const t = todayStr();
  if (s === t) return 'Today';
  if (s === addDays(t, 1)) return 'Tomorrow';
  if (s === addDays(t, -1)) return 'Yesterday';
  return new Date(`${s}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}
export function fmtTime(hhmm) {
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  return `${h % 12 || 12}:${pad(m)} ${h < 12 ? 'AM' : 'PM'}`;
}
/** "Tomorrow · 9:30 AM" / "Wed, Oct 2" / '' when unscheduled. */
export const whenText = (job) => (job.scheduled_date ? `${dayLabel(job.scheduled_date)}${job.scheduled_time ? ` · ${fmtTime(job.scheduled_time)}` : ''}` : '');
export const fmtDay = (s) => (s ? new Date(`${s}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '');
