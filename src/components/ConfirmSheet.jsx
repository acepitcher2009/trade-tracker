import { useEffect, useRef } from 'react';

/** A plain-language yes/no pop-up (used instead of the browser's own alert and confirm boxes). */
export default function ConfirmSheet({ title, children, confirmLabel = 'Yes', cancelLabel = 'Cancel', danger, onConfirm, onCancel }) {
  const first = useRef(null);
  useEffect(() => { first.current?.focus(); }, []);
  useEffect(() => {
    const k = (e) => e.key === 'Escape' && onCancel();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onCancel]);
  return (
    <div className="sheet-back" onClick={onCancel}>
      <div className="sheet" role="alertdialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        {children && <p className="sheet-line">{children}</p>}
        <button ref={first} className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} onClick={onConfirm}>{confirmLabel}</button>
        {cancelLabel && <button className="link sheet-cancel" onClick={onCancel}>{cancelLabel}</button>}
      </div>
    </div>
  );
}
