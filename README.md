# Trade Tracker

Mobile-first, offline-first client and job tracker for local service businesses (fence, stain, and other trades). React + Vite PWA, Netlify Functions, Neon Postgres. Multi-tenant: each business signs in with its slug + PIN.

## How it works
- **Home board**: search box ("new or existing?") plus tabs: Estimates, Quotes, Jobs, Payments, Clients. Each job card shows only its current stage and the next step.
- **Quotes**: line items, add-ons, packages, minimum charge, deposits/milestones, per-line sales-tax on/off. Customers open a private link, tick "I agree", and accept; the owner gets an in-app notice and (if enabled) a phone alert.
- **Job flow**: a new customer has no job type; the kind of job is picked in the quote form. Unanswered quotes can be deleted from Quotes Sent, and customers can decline from their quote link (the owner sees the reason). Each job keeps a payment log (amount, method, date) so Payments shows what is owed and what came in this month. Job notes are editable. A new customer can be saved without booking a site visit.
- **Free helpers**: "Follow up" text for quotes quiet 3+ days, "On my way" / "Remind" texts, money summary on Payments. All texts open Messages pre-filled; nothing is sent automatically.
- **Offline**: everything is read from and written to IndexedDB first, then synced (idempotent op queue, last-write-wins, delta sync).
- **Per-trade background**: chosen when a business is onboarded; one shared app icon.

## Guided tour
After a contractor signs in for the first time on a phone, a short tour runs on pretend customers (`src/tour/`). It uses its own local database (`createData(..., { demo: true })`), never calls the server or queues changes, and deletes itself when it ends. It can be skipped anytime and replayed from the Details panel.

## Setup
```
npm install
cp .env.example .env   # or edit the existing .env: DATABASE_URL (dev branch!), etc.
npm run migrate -- --dev
npm run seed / onboard / invite ...   # see scripts/
npm run vapid          # generates push keys into .env (private key is never printed)
npm run dev
```
Add `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` (optional `VAPID_SUBJECT`) to Netlify env vars for phone alerts.

## Database safety
Scripts refuse to touch a database that is not marked dev (`tt_env` table). `migrate` needs `--dev` (marks dev) or `--production`. Onboard/seed/set-pin/invite require a dev-marked DB or `--production`. Never put the DATABASE_URL in code or chat.

## Tests
`node --test test/api.test.js test/quote.test.js test/phone.test.js test/hardening.test.js` and `node --test test/sync.test.js` (run against the dev branch, ~1 min each).

## Before launch
Run `npm run migrate -- --production` (migrations 011 and 012 are only on dev), set VAPID vars on Netlify, then deploy.
