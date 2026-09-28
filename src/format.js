export const fmtDate = (iso) =>
  new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
export const jobsText = (n) => (n === 0 ? 'No jobs yet' : `${n} job${n === 1 ? '' : 's'}`);
