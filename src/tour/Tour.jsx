import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { STEPS } from './steps.js';

/**
 * The guided tour: a small card that points at the real buttons on the sample data. It never blocks taps (except on the
 * welcome and finish cards), moves on by itself when you do what it asks, and can be skipped at any point.
 */
export default function Tour({ data, screen, go, onEnd }) {
  const [i, setI] = useState(0);
  const [jobs, setJobs] = useState([]);
  const [rect, setRect] = useState(null);
  const [place, setPlace] = useState('bottom');
  const [bottom, setBottom] = useState(96);
  const [covered, setCovered] = useState(false); // a pop-up (calendar, payment) is open: stay out of its way
  const cardRef = useRef(null);
  const step = STEPS[i];
  const last = i === STEPS.length - 1;

  const screenRef = useRef(screen);
  screenRef.current = screen;
  // Steps that live on the quote form are skipped when the quote form is not open.
  const next = () => setI((n) => {
    let m = n + 1;
    while (m < STEPS.length - 1 && STEPS[m].screen && STEPS[m].screen !== screenRef.current) m += 1;
    return Math.min(m, STEPS.length - 1);
  });

  // Move the app to where this step lives.
  useEffect(() => { if (!step.modal && !step.screen && step.tab) go(step.tab); }, [i]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the sample jobs handy to see whether the person did the thing.
  useEffect(() => {
    let live = true;
    const read = () => data.board().then((r) => live && setJobs(r));
    read();
    const un = data.subscribe(read);
    return () => { live = false; un(); };
  }, [data]);

  // Move on by itself when the step's action is done.
  useEffect(() => {
    if (step.done && step.done({ screen, jobs })) { const t = setTimeout(next, 700); return () => clearTimeout(t); }
    return undefined;
  }, [step, screen, jobs]); // eslint-disable-line react-hooks/exhaustive-deps

  // Leaving the quote form ends its steps.
  useEffect(() => { if (step.screen && screen !== step.screen) next(); }, [screen, i]); // eslint-disable-line react-hooks/exhaustive-deps

  // Follow the target as the screen changes, scrolling so it sits clear of the tour card.
  useLayoutEffect(() => {
    document.body.classList.add('tour-on');
    let el0 = null, tries = 0;
    const measure = () => {
      setCovered(!!document.querySelector('.sheet-back'));
      const el = step.target?.();
      if (!el) { setRect(null); return; }
      if (el !== el0) { el0 = el; tries = 0; }
      const r = el.getBoundingClientRect();
      setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
      const chrome = Math.max(document.querySelector('.bottomnav')?.offsetHeight ?? 0, document.querySelector('.qbar')?.offsetHeight ?? 0);
      setBottom(chrome + 10);
      const cardH = cardRef.current?.offsetHeight ?? 220;
      const inBottomBar = !!el.closest('.bottomnav, .qbar'); // the target is itself part of the bottom bar (not merely below the fold)
      const H = window.innerHeight, topGap = 112;
      const zoneBelow = H - chrome - cardH - 20 - 70;   // room above a bottom card
      const zoneAbove = H - chrome - 8 - (topGap + cardH + 10); // room under a top card
      const pl = inBottomBar || r.height > zoneBelow && zoneAbove > zoneBelow ? 'top' : 'bottom';
      setPlace(pl);
      if (!inBottomBar && tries < 14) {
        const lo = pl === 'bottom' ? 70 : topGap + cardH + 10;
        const hi = pl === 'bottom' ? H - chrome - cardH - 20 : H - chrome - 8;
        if (r.top < lo) { tries += 1; window.scrollBy({ top: r.top - lo, behavior: 'instant' }); }
        else if (r.bottom > hi) { tries += 1; window.scrollBy({ top: Math.min(r.bottom - hi, r.top - lo), behavior: 'instant' }); }
      }
    };
    measure();
    const t = setInterval(measure, 150);
    window.addEventListener('resize', measure);
    return () => { clearInterval(t); window.removeEventListener('resize', measure); };
  }, [i, screen, jobs]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => document.body.classList.remove('tour-on'), []);

  const dots = `${Math.max(i, 1)} of ${STEPS.length - 2}`;
  if (step.modal) {
    return (
      <div className="tour-back" role="dialog" aria-modal="true" aria-label="App tour">
        <div className="tour-modal">
          <h2>{step.title}</h2>
          <p>{step.text}</p>
          <button className="btn btn-primary" onClick={last ? onEnd : next} autoFocus>{step.next}</button>
          {!last && <button className="link" onClick={onEnd}>Skip the tour</button>}
        </div>
      </div>
    );
  }
  if (covered) return null;
  return (
    <>
      {rect && <div className="tour-ring" style={{ top: rect.top - 4, left: rect.left - 4, width: rect.width + 8, height: rect.height + 8 }} aria-hidden="true" />}
      <aside ref={cardRef} className="tour-card" style={place === 'top' ? { top: 112 } : { bottom }} role="region" aria-label="App tour">
        <div className="tour-step">{dots}</div>
        <h2>{step.title}</h2>
        <p>{step.text}</p>
        {step.action && <p className="tour-try">{step.action}</p>}
        <div className="tour-actions">
          <button className="btn btn-primary" onClick={next}>{step.action ? 'Skip this step' : 'Next'}</button>
          <button className="link" onClick={onEnd}>Skip the tour</button>
        </div>
      </aside>
    </>
  );
}
