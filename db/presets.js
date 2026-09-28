// Trade presets: seed job types, terminology and accent color for a new business.
// Add a trade by adding an entry here — no other code changes needed.

const STATUSES = [
  { key: 'quoted',    label: 'Quoted',    color: '#b45309' },
  { key: 'scheduled', label: 'Scheduled', color: '#1d4ed8' },
  { key: 'done',      label: 'Done',      color: '#15803d' },
  { key: 'paid',      label: 'Paid',      color: '#475569' },
];

const CLIENT_TERMS   = { client: 'Client',   clients: 'Clients',   job: 'Job', jobs: 'Jobs' };
const CUSTOMER_TERMS = { client: 'Customer', clients: 'Customers', job: 'Job', jobs: 'Jobs' };

export const PRESETS = {
  fence: {
    accent: '#92400e',
    terms: CLIENT_TERMS,
    statuses: STATUSES,
    jobTypes: ['Fence Installation', 'Repair', 'Staining & Sealing'],
  },
  roofing: {
    accent: '#b91c1c',
    terms: CUSTOMER_TERMS,
    statuses: STATUSES,
    jobTypes: ['Roof Replacement', 'Roof Repair', 'Inspection', 'Gutters'],
  },
  lawn: {
    accent: '#166534',
    terms: CUSTOMER_TERMS,
    statuses: STATUSES,
    jobTypes: ['Mowing', 'Cleanup', 'Mulching', 'Irrigation Repair'],
  },
  'pressure-washing': {
    accent: '#0369a1',
    terms: CUSTOMER_TERMS,
    statuses: STATUSES,
    jobTypes: ['House Wash', 'Driveway & Concrete', 'Deck & Fence', 'Roof Wash'],
  },
};

export function getPreset(name) {
  const p = PRESETS[name];
  if (!p) throw new Error(`Unknown preset "${name}". Available: ${Object.keys(PRESETS).join(', ')}`);
  return p;
}
