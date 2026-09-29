// Phone rules shared by server and (later) the PWA so both normalize identically.
// Store digits only, 10 digits, leading US country code "1" stripped.

/** Returns a 10-digit string, or null if the input is not a valid full US number. */
export function normalizePhone(input) {
  if (input == null) return null;
  let d = String(input).replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  return /^\d{10}$/.test(d) ? d : null;
}

/** "9794921302" -> "(979) 492-1302" (returns input unchanged if not 10 digits). */
export function formatPhone(digits) {
  const d = String(digits ?? '');
  return /^\d{10}$/.test(d) ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : d;
}
