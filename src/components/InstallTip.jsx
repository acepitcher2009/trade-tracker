import { platform } from '../install.js';

// Step-by-step install help, shown only on the install page (never inside the installed app).
// The steps for the visitor's own phone are open by default.
export default function InstallTip({ canPrompt, onPrompt }) {
  const p = platform();
  return (
    <div className="tips">
      {canPrompt && <button className="btn btn-primary" onClick={onPrompt}>Install app</button>}
      <details className="tip" open={p !== 'android'}>
        <summary>iPhone or iPad</summary>
        <ol>
          <li>Open this page in <strong>Safari</strong> (not inside another app).</li>
          <li>Tap the <strong>Share</strong> button (square with an arrow) at the bottom.</li>
          <li>Scroll down and tap <strong>Add to Home Screen</strong>, then <strong>Add</strong>.</li>
          <li>Open the app from your home screen to sign in.</li>
        </ol>
      </details>
      <details className="tip" open={p === 'android'}>
        <summary>Android phone or tablet</summary>
        <ol>
          <li>Open this page in <strong>Chrome</strong>.</li>
          <li>Tap the <strong>⋮ menu</strong> (three dots) at the top right.</li>
          <li>Tap <strong>Install app</strong> (or <strong>Add to Home screen</strong>), then <strong>Install</strong>.</li>
          <li>Open the app from your home screen to sign in.</li>
        </ol>
      </details>
    </div>
  );
}
