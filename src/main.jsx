import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import PublicQuote from './screens/PublicQuote.jsx';
import './styles.css';
import { applyTrade, rememberedTrade } from './theme.js';

applyTrade(rememberedTrade()); // the sign-in screen wears the trade it was last used for

// A client opening the link from their text message sees just their quote (no app, no sign-in).
const quoteToken = new URLSearchParams(window.location.search).get('q');
createRoot(document.getElementById('root')).render(quoteToken ? <PublicQuote token={quoteToken} /> : <App />);

// Installable + offline app shell (production only, so dev hot-reload isn't cached).
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}); });
}
