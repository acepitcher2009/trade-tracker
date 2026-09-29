// Is this page running as the installed home-screen app, and which install invite (if any) opened it?
export function isStandalone() {
  try {
    return window.matchMedia('(display-mode: standalone)').matches
      || window.matchMedia('(display-mode: fullscreen)').matches
      || window.navigator.standalone === true; // iPhone / iPad
  } catch { return false; }
}
export const inviteToken = () => new URLSearchParams(window.location.search).get('i') || '';
export const stripToken = () => { try { window.history.replaceState(null, '', window.location.pathname); } catch { /* ignore */ } };
export const platform = () => (/iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1) ? 'ios'
  : /Android/.test(navigator.userAgent) ? 'android' : 'other');
