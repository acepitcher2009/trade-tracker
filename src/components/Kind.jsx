// NEW = no finished (Done/Paid) job yet. EXISTING = a past customer. Same rule everywhere in the app.
export default function Kind({ existing }) {
  return <span className={`kind ${existing ? 'kind-existing' : 'kind-new'}`}>{existing ? 'Existing' : 'New'}</span>;
}
