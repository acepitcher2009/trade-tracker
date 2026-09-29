// A business's own data, as JSON or CSV. Used by GET /api/export (session-scoped) and `npm run export`.
import { query } from './db.js';
import { formatPhone } from '../shared/phone.js';

export async function loadExport(businessId) {
  const [business] = await query(
    'select name, slug, phone_digits, city, state, accent_color, terms, license_no, quote_terms, min_charge_cents, uses_visits, default_deposit_pct, valid_days from businesses where id = $1', [businessId]);
  const job_types = await query('select name, active from job_types where business_id = $1 order by sort_order, name', [businessId]);
  const statuses = await query('select key, label from statuses where business_id = $1 order by sort_order', [businessId]);
  const clients = await query(
    `select id, name, phone_digits, address_line, city, state, zip,
            case when address_line is not null then address_line || ', ' || city || ', ' || state || ' ' || zip else address end as address,
            notes, created_at, updated_at from clients
      where business_id = $1 order by lower(name), id`, [businessId]);
  const jobs = await query(
    `select j.id, j.client_id, jt.name as job_type, s.label as status, j.notes, j.created_at, j.updated_at,
            j.scheduled_date::text as scheduled_date, to_char(j.scheduled_time, 'HH24:MI') as scheduled_time,
            (select coalesce(sum((p->>'amount_cents')::bigint), 0) / 100.0 from jsonb_array_elements(j.payments) p)::float as paid_dollars
       from jobs j
       left join job_types jt on jt.business_id = j.business_id and jt.id = j.job_type_id
       join statuses  s  on s.business_id  = j.business_id and s.id  = j.status_id
      where j.business_id = $1 and j.deleted_at is null order by j.created_at, j.id`, [businessId]);
  const byClient = new Map(clients.map((c) => [c.id, { ...c, jobs: [] }]));
  for (const j of jobs) byClient.get(j.client_id)?.jobs.push(j);
  return { exported_at: new Date().toISOString(), business, job_types, statuses, clients: [...byClient.values()] };
}

// Spreadsheet apps run cells starting with = + - @ as formulas. Neutralize them (CSV injection).
function cell(v) {
  let s = v == null ? '' : v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const COLUMNS = ['client_name', 'client_phone', 'client_street', 'client_city', 'client_state', 'client_zip', 'client_address', 'client_notes', 'client_created',
  'job_type', 'job_status', 'job_scheduled_date', 'job_scheduled_time', 'job_notes', 'job_created', 'job_updated', 'job_paid'];

/** One row per job (clients with no jobs get one row with empty job columns). Excel-friendly (BOM, CRLF). */
export function toCsv(data) {
  const rows = [COLUMNS];
  for (const c of data.clients) {
    const base = [c.name, formatPhone(c.phone_digits), c.address_line, c.city, c.state, c.zip, c.address, c.notes, c.created_at];
    if (!c.jobs.length) rows.push([...base, '', '', '', '', '', '', '', '']);
    for (const j of c.jobs) rows.push([...base, j.job_type, j.status, j.scheduled_date, j.scheduled_time, j.notes, j.created_at, j.updated_at, j.paid_dollars]);
  }
  return `﻿${rows.map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`;
}
