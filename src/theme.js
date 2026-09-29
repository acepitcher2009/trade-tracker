// Per-trade look: the sign-in/install background comes from the business's trade preset.
// Every trade shares the same app icon; fence uses the original background.
const ART = new Set(['roofing', 'lawn', 'pressure-washing', 'plumbing', 'electrical', 'hvac', 'painting', 'junk-removal',
  'land-clearing', 'tree-service', 'handyman', 'concrete', 'general-contractor', 'pest-control']);
const get = () => { try { return localStorage.getItem('tt_preset') || ''; } catch { return ''; } };

/** Apply a trade's background to the page, and remember it for the next sign-in screen. */
export function applyTrade(preset) {
  const p = ART.has(preset) ? preset : '';
  try { if (preset) localStorage.setItem('tt_preset', preset); } catch { /* ignore */ }
  const root = document.documentElement;
  if (p) root.style.setProperty('--hero', `url('/heroes/${p}.jpg')`); else root.style.removeProperty('--hero');
}
export const rememberedTrade = get;
