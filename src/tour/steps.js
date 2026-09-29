// The guided tour, one step at a time. `target` finds the thing to point at (or nothing); `tab`/`screen` say where the step
// lives; `done` (optional) lets the tour move on by itself when the person does the thing being described.
const card = (name) => [...document.querySelectorAll('.jobcard')].find((el) => el.textContent.includes(name));
const btn = (name, label) => [...(card(name)?.querySelectorAll('.btn') ?? [])].find((b) => b.textContent.trim().startsWith(label));
const job = (jobs, name) => jobs.find((j) => j.client_name.includes(name));

export const STEPS = [
  { id: 'welcome', modal: true, title: 'Welcome! Take a 2 minute tour',
    text: 'You will follow a few pretend customers from the first phone call to getting paid. It is all sample data, so nothing you tap here touches your real list and nothing is sent to anyone.', next: 'Start the tour' },
  { id: 'search', tab: 'clients', target: () => document.querySelector('.search'), title: 'Every call starts here',
    text: 'When the phone rings, type the caller’s name or number. The app tells you if they are new or already a customer. Not in the list? Tap Add and enter their details.' },
  { id: 'visit', tab: 'estimates', target: () => btn('Dana Rivers', 'Schedule visit'), title: 'Book the site visit',
    text: 'New calls wait here until you book a time to look at the job. Tap Schedule visit on Dana and pick a day and time.',
    action: 'Try it: tap Schedule visit', done: ({ jobs }) => job(jobs, 'Dana')?.status_key === 'visit' },
  { id: 'quoteit', tab: 'estimates', target: () => btn('Mike Turner', 'Quote it'), title: 'At the job, quote it',
    text: 'Mike’s visit is today. When you are at his place, tap Quote it.',
    action: 'Try it: tap Quote it', done: ({ screen }) => screen === 'quote' },
  { id: 'form', screen: 'quote', target: () => document.querySelector('[aria-label="Kind of job"]'), title: 'Build the quote',
    text: 'Pick the kind of job, then tap services to add them. The total updates as you go.' },
  { id: 'send', screen: 'quote', target: () => document.querySelector('.qbar .btn'), title: 'Save and send',
    text: 'Save and send lets you text the customer a link. They see a clean itemized quote and can accept or decline on their phone. In this tour nothing really sends.' },
  { id: 'quotes', tab: 'quotes', target: () => [...(card('Priya Shah')?.querySelectorAll('.btn') ?? [])].find((b) => b.textContent.trim() === 'Follow up'), title: 'Quotes waiting on an answer',
    text: 'Sent quotes wait here. Quiet for 3 days? A Follow up button appears that texts the customer for you. A quote that went nowhere can be deleted, and customers can decline from their link.' },
  { id: 'jobs', tab: 'jobs', target: () => btn('Luis Ortega', 'Schedule job'), title: 'They said yes',
    text: 'Accepted quotes land here. Tap Schedule job and pick the day. Then you get On my way and Remind buttons.',
    action: 'Try it: tap Schedule job', done: ({ jobs }) => job(jobs, 'Luis')?.status_key === 'scheduled' },
  { id: 'pay', tab: 'payments', target: () => btn('Tom Nguyen', 'Record payment'), title: 'Get paid',
    text: 'When the work is done, tap Mark done on the job, then Record payment here. Enter what they paid and how. Deposits work the same way. The numbers at the top show what you are owed and what came in this month.',
    action: 'Try it: tap Record payment', done: ({ jobs }) => (job(jobs, 'Tom')?.payments?.length ?? 0) > 0 },
  { id: 'prices', tab: 'clients', target: () => [...document.querySelectorAll('.topbar .link')].find((b) => b.textContent.trim() === 'Prices'), title: 'Your prices',
    text: 'Prices is where your services, prices, sales tax, deposit and terms live. Keep it current and quotes take a few taps.' },
  { id: 'status', tab: 'clients', target: () => document.querySelector('.pill'), title: 'Works with no signal',
    text: 'Everything is saved on your phone first, so it works in a dead zone and sends when you have signal again. This light shows the state. Tap it any time for details and alerts.' },
  { id: 'finish', modal: true, title: 'That is it!', text: 'Your real customer list is next. You can replay this tour any time from the Details panel (tap the sync light at the top).', next: 'Start using the app' },
];
