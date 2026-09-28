import { useState } from 'react';
import { api } from '../api.js';

const store = {
  get: (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

export default function Login({ onDone }) {
  const [slug, setSlug] = useState(store.get('tt_slug'));
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      await api.login(slug.trim().toLowerCase(), pin);
      store.set('tt_slug', slug.trim().toLowerCase());
      await onDone();
    } catch (ex) {
      setErr(ex.message); setPin(''); setBusy(false);
    }
  };

  return (
    <main className="login-wrap">
    <form className="login" onSubmit={submit}>
      <h1>Trade Tracker</h1>
      <label>Business ID
        <input value={slug} onChange={(e) => setSlug(e.target.value)} autoCapitalize="none" autoCorrect="off"
          spellCheck="false" autoComplete="username" placeholder="your-business" required />
      </label>
      <label>PIN
        <input value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))}
          type="password" inputMode="numeric" pattern="[0-9]*" autoComplete="current-password"
          autoFocus={!!slug} placeholder="6–8 digits" required />
      </label>
      {err && <p className="error" role="alert">{err}</p>}
      <button className="btn btn-primary" disabled={busy || !slug || pin.length < 6}>
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
    </main>
  );
}
