// One address rule for the server AND the app: house number + street name, city, 2-letter state, 5-digit ZIP.
export const STATES = ['AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY'];

const squash = (v) => String(v ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();

/** -> { ok: true, value: { line, city, state, zip } } or { ok: false, field, error } */
export function validateAddress({ line, city, state, zip } = {}) {
  const l = squash(line), c = squash(city), s = squash(state).toUpperCase(), z = squash(zip);
  if (!l) return { ok: false, field: 'address_line', error: 'Enter the street address (house number and street).' };
  if (l.length > 120 || !/^\d+[A-Za-z]?(-\d+)?\s+\S*[A-Za-z0-9]/.test(l) || !/[A-Za-z]/.test(l)) {
    return { ok: false, field: 'address_line', error: 'Start with the house number, then the street name, like 1204 Live Oak Dr.' };
  }
  if (!/^[A-Za-z][A-Za-z .'\-]{1,59}$/.test(c)) return { ok: false, field: 'city', error: 'Enter the city.' };
  if (!STATES.includes(s)) return { ok: false, field: 'state', error: 'Pick the state.' };
  if (!/^\d{5}$/.test(z)) return { ok: false, field: 'zip', error: 'Enter the 5-digit ZIP code.' };
  return { ok: true, value: { line: l, city: c, state: s, zip: z } };
}

export const formatAddress = ({ line, city, state, zip }) => `${line}, ${city}, ${state} ${zip}`;
