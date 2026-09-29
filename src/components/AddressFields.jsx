import { STATES } from '../../shared/address.js';

/** Street (house number + name), city, state, ZIP. `value` = { line, city, state, zip }. */
export default function AddressFields({ value, onChange, legend = 'Address' }) {
  const set = (k) => (e) => onChange({ ...value, [k]: e.target.value });
  return (
    <fieldset className="addr">
      <legend>{legend} <span className="req">(required)</span></legend>
      <label className="field">Street address
        <input value={value.line} onChange={set('line')} autoComplete="address-line1" autoCapitalize="words"
          placeholder="1204 Live Oak Dr" maxLength={120} />
      </label>
      <label className="field">City
        <input value={value.city} onChange={set('city')} autoComplete="address-level2" autoCapitalize="words"
          placeholder="Bryan" maxLength={60} />
      </label>
      <div className="row">
        <label className="field">State
          <select value={value.state} onChange={set('state')} autoComplete="address-level1">
            {STATES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label className="field">ZIP code
          <input value={value.zip} onChange={(e) => onChange({ ...value, zip: e.target.value.replace(/\D/g, '').slice(0, 5) })}
            autoComplete="postal-code" inputMode="numeric" placeholder="77802" maxLength={5} />
        </label>
      </div>
    </fieldset>
  );
}
