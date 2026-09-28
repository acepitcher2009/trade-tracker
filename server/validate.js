import { HttpError } from './http.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function isUuid(v) { return typeof v === 'string' && UUID.test(v); }

export function uuid(v, field, { optional = false } = {}) {
  if (v === undefined || v === null || v === '') {
    if (optional) return null;
    throw new HttpError(400, `${field} is required`, { field });
  }
  if (!isUuid(v)) throw new HttpError(400, `${field} must be a valid id`, { field });
  return v.toLowerCase();
}

/** Trimmed, control-char-stripped string. Empty -> null when optional. */
export function str(v, field, { max, optional = false } = {}) {
  if (v === undefined || v === null) {
    if (optional) return null;
    throw new HttpError(400, `${field} is required`, { field });
  }
  if (typeof v !== 'string') throw new HttpError(400, `${field} must be text`, { field });
  const s = v.replace(CTRL, '').trim();
  if (!s) {
    if (optional) return null;
    throw new HttpError(400, `${field} is required`, { field });
  }
  if (s.length > max) throw new HttpError(400, `${field} is too long (max ${max})`, { field });
  return s;
}
