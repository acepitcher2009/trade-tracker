// A business's own data, as JSON or CSV. Used by GET /api/export (session-scoped) and `npm run export`.
import { query } from './db.js';
import { formatPhone } from '../shared/phone.js';

export async function loadExport(businessId) {
  const [business] = await query(
    'select name, slug, phone_digits, city, state, accent_color, terms from businesses where id = $1', [businessId]);
  const job_types = await query('select name, active from job_types where business_id = $1 order by sort_order, name', [businessId]);
  const statuses = await query('select key, label from statuses where business_id = $1 order by sort_order', [businessId]);
  const clients = await query(
    `select id, name, phone_digits, address, notes, created_at, updated_at from clients
      where business_id = $1 order by lower(name), id`, [businessId]);
  const jobs = await query(
    `select j.id, j.client_id, jt.name as job_type, s.label as status, j.notes, j.created_at, j.updated_at
       from jobs j
       join job_types jt on jt.business_id = j.business_id and jt.id = j.job_type_id
       join statuses  s  on s.business_id  = j.business_id and s.id  = j.status_id
      where j.business_id = $1 order by j.created_at, j.id`, [businessId]);
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

const COLUMNS = ['client_name', 'client_phone', 'client_address', 'client_notes', 'client_created',
  'job_type', 'job_status', 'job_notes', 'job_created', 'job_updated'];

/** One row per job (clients with no jobs get one row with empty job columns). Excel-friendly (BOM, CRLF). */
export function toCsv(data) {
  const rows = [COLUMNS];
  for (const c of data.clients) {
    const base = [c.name, formatPhone(c.phone_digits), c.address, c.notes, c.created_at];
    if (!c.jobs.length) rows.push([...base, '', '', '', '', '']);
    for (const j of c.jobs) rows.push([...base, j.job_type, j.status, j.notes, j.created_at, j.updated_at]);
  }
  return `﻿${rows.map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`;
}
