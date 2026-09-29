import { useState } from 'react';

const PITCH = [['Flat to 3/12', 1.03], ['4/12', 1.054], ['6/12', 1.118], ['8/12', 1.202], ['10/12', 1.302], ['12/12', 1.414]];
const LOADS = [['1/8 truck', 0.13], ['1/4 truck', 0.25], ['1/2 truck', 0.5], ['3/4 truck', 0.75], ['Full truck', 1]];
const num = (v) => parseFloat(String(v).replace(/[^0-9.]/g, '')) || 0;
const r2 = (n) => Math.round(n * 100) / 100;

/** A small helper that turns measurements into a quantity, so nobody does the math on a ladder. */
const LABELS = { area: 'Area', run: 'Fence or run', roof: 'Roof squares', load: 'Truck load', acre: 'Acres' };

export default function Measure({ modes = ['area'], onUse, onClose }) {
  const [mode, setMode] = useState(modes[0]);
  const [runs, setRuns] = useState('');
  const [len, setLen] = useState('');
  const [wid, setWid] = useState('');
  const [pitch, setPitch] = useState(1.118);
  const [waste, setWaste] = useState(true);

  const area = num(len) * num(wid);
  const runTotal = runs.split(/[,\s]+/).reduce((n, v) => n + num(v), 0);
  const squares = (area * pitch * (waste ? 1.1 : 1)) / 100;
  return (
    <div className="measure" role="group" aria-label="Measure">
      <div className="seg">
        {modes.map((k) => (
          <button key={k} type="button" className={mode === k ? 'on' : ''} aria-pressed={mode === k} onClick={() => setMode(k)}>{LABELS[k]}</button>
        ))}
      </div>
      {['area', 'roof', 'acre'].includes(mode) && (
        <div className="qb-row qb-math">
          <label>Length (ft)<input inputMode="decimal" value={len} onChange={(e) => setLen(e.target.value)} /></label>
          <label>Width (ft)<input inputMode="decimal" value={wid} onChange={(e) => setWid(e.target.value)} /></label>
        </div>
      )}
      {mode === 'run' && (
        <>
          <label className="field">Length of each side in feet, separated by commas
            <input inputMode="decimal" value={runs} onChange={(e) => setRuns(e.target.value.replace(/[^0-9.,\s]/g, ''))} placeholder="120, 85, 120, 85" />
          </label>
          <button type="button" className="btn btn-ghost" disabled={runTotal <= 0} onClick={() => onUse(r2(runTotal))}>Use {r2(runTotal)} ft</button>
        </>
      )}
      {mode === 'acre' && <button type="button" className="btn btn-ghost" disabled={area <= 0} onClick={() => onUse(r2(area / 43560))}>Use {r2(area / 43560)} acres</button>}
      {mode === 'area' && <button type="button" className="btn btn-ghost" disabled={area <= 0} onClick={() => onUse(r2(area))}>Use {r2(area)} sq ft</button>}
      {mode === 'roof' && (
        <>
          <label className="field">Roof steepness
            <select value={pitch} onChange={(e) => setPitch(Number(e.target.value))}>{PITCH.map(([l, f]) => <option key={l} value={f}>{l}</option>)}</select>
          </label>
          <label className="qb-check"><input type="checkbox" checked={waste} onChange={(e) => setWaste(e.target.checked)} />Add 10% for waste</label>
          <p className="hint">Length × width of the house footprint, adjusted for steepness. One square = 100 sq ft.</p>
          <button type="button" className="btn btn-ghost" disabled={area <= 0} onClick={() => onUse(r2(squares))}>Use {r2(squares)} squares</button>
        </>
      )}
      {mode === 'load' && (
        <div className="chips">
          {LOADS.map(([l, v]) => <button key={l} type="button" className="chip-add" onClick={() => onUse(v)}>{l}</button>)}
        </div>
      )}
      <button type="button" className="link" onClick={onClose}>Close</button>
    </div>
  );
}
