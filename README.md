# Trade Tracker

A mobile-first client and job tracker for local service businesses (fence, roofing, lawn care, pressure washing…). It answers one question in seconds: **"Is this caller a NEW or EXISTING client?"** — even with no cell signal.

Built as a reusable multi-tenant product: every business is its own tenant, configured through the database (name, colors, job types, status labels, terminology). New customers are onboarded with one command, never by forking code.

First tenant: **Deno Fence and Stain** (Bryan, TX).

## What it does

- **Lookup home screen** — type or paste a phone number (any format) or just the last 4 digits. Big green **EXISTING CLIENT** banner (name, job count, last job and date) or blue **NEW CLIENT** banner with a one-tap **Add client**.
- **Client card** — tap-to-call, tap-to-text, directions (Apple Maps on iPhone, Google Maps elsewhere), notes, job history, one-tap job status (Quoted → Scheduled → Done → Paid).
- **Quick add** — phone prefilled, name + one big job-type button + Save.
- **Works offline** — installable to the home screen; lookup, add, and status changes all work with no signal and sync automatically when it returns.
- **Data export** — each business can download its own data (CSV or JSON).

Out of scope for v1: SMS/text lookup, push notifications, photos, invoicing, payments, contact import, multi-user crews.

## Stack

React + Vite (PWA) · Netlify Functions (Node) · Neon Postgres (serverless driver) · IndexedDB (`idb`) for the offline copy and sync queue. No paid services.

## Project layout

```
src/                 React app (screens, offline data layer in data.js, service-worker registration)
public/              manifest, icons, service worker (sw.js)
server/              API handlers, auth, export — shared by Netlify and the local dev server
netlify/functions/   api.js — the single function serving /api/*
db/migrations/       SQL schema
db/presets.js        Trade presets (fence, roofing, lawn, pressure-washing)
shared/              Phone normalization + PIN hashing (used by server and app)
scripts/             migrate, seed, onboard, set-pin, export
test/                Unit, API, tenant-isolation and offline-sync tests
```

## Environment variables

You only ever need **one** secret:

| Name | Where | What |
| --- | --- | --- |
| `DATABASE_URL` | local `.env` (git-ignored) and Netlify site settings | Neon connection string |
| `DENO_PIN` | local `.env`, only for `npm run seed` | 6–8 digit PIN for the Deno tenant. Delete it from `.env` after seeding. |

`.env.example` lists them. **Never commit `.env`, never paste connection strings into chat, code or issues.**

### Neon branches (important)

The Neon project has two branches:

- **`dev`** — local development and every test. Your local `.env` points here.
- **`production`** — the live data. Only the deployed Netlify site (and the one-time migration/onboarding steps below) should ever touch it.

Never run `npm test`, `npm run seed`, or experiments with the production connection string. The tests create and delete throwaway businesses named `zz-test-…`; they are safe on `dev` only.

## Local development

Requires Node 20 or newer.

```bash
npm install
cp .env.example .env        # then fill in DATABASE_URL (Neon "dev" branch)
npm run migrate             # create/upgrade tables
npm run seed                # creates Deno Fence and Stain (needs DENO_PIN in .env)
npm run dev                 # http://localhost:5173 — the API is served locally too, no extra tools
npm test                    # unit + API + isolation + offline-sync tests (against dev)
npm run build               # production build into dist/
```

Sign in with business ID `deno-fence-and-stain` and the PIN you set. To change a PIN later: `npm run set-pin -- deno-fence-and-stain` (typed hidden; signs that business out everywhere).

> The service worker only runs in production builds, so `npm run dev` never caches anything. To try the installable/offline behavior, deploy (below) or run `npm run build && npm run preview`.

## Deploy (Netlify + Neon)

Use a **new** Netlify site dedicated to this app.

1. **Push the repo to GitHub.**
2. **Netlify → Add new site → Import an existing project →** pick this repo. The build settings come from `netlify.toml` (build `npm run build`, publish `dist`, functions `netlify/functions`, Node 22). Do not reuse any other site.
3. **Environment variables** (Site configuration → Environment variables → Add a variable → *Add a single variable*). Add `DATABASE_URL` and tick **Contains secret values**. Use different values per deploy context:
   - **Production** → the Neon **`production`** branch connection string.
   - **Deploy previews / Branch deploys** → the Neon **`dev`** branch string, so previews can never touch live data.
4. **Migrate the production database once** (from your own computer, using your shell's variable — it overrides `.env`):

   PowerShell:
   ```powershell
   $env:DATABASE_URL = "<paste production connection string>"
   npm run migrate
   Remove-Item Env:DATABASE_URL
   ```
   macOS/Linux:
   ```bash
   DATABASE_URL="<paste production connection string>" npm run migrate
   ```
   Re-run this step whenever a release adds a file to `db/migrations/`.
5. **Create the first business on production** (same technique — see *Onboard a new business* below), e.g. Deno.
6. **Deploy**, open the site over HTTPS, sign in, and check:
   - Lookup works; add a test client.
   - Turn on airplane mode, reload from the home-screen icon, and look up a client. Add one; turn signal back on and watch the status bar go to **Synced**.
   - Site configuration → Functions shows `api`.

Every push to the main branch redeploys. Phones pick up a new version the next time the app opens with signal.

## Onboard a new business

Takes a couple of minutes, no code changes.

1. Point the command at the right database (production: use the PowerShell/bash variable technique from *Deploy* step 4).
2. Run (interactive prompts, or flags):

   ```bash
   npm run onboard -- --name "Acme Roofing" --preset roofing \
     --phone "(979) 555-0100" --city Bryan --state TX
   ```

   Options: `--slug acme-roofing` (login ID; defaults from the name), `--accent "#b91c1c"` (brand color; defaults from the preset). The PIN (6–8 digits) is typed hidden and never printed. For a non-interactive run, set `ONBOARD_PIN` in the environment.
3. Give the owner: the site URL, their **Business ID** (the slug), and their PIN — through separate channels if you can.
4. Have them open the site in **Safari → Share → Add to Home Screen** (there's a how-to inside the app), sign in once with signal, and wait for **Synced** before going into the field.

**Presets** seed job types, statuses, terminology and color: `fence`, `roofing`, `lawn`, `pressure-washing`. To add a trade, add an entry to `db/presets.js` — nothing else changes.

**Tailoring a business afterward** (Neon SQL editor, against the right branch; phones pick changes up on their next sync):

```sql
-- add a job type
insert into job_types (business_id, name, sort_order)
select id, 'Gate Install', 10 from businesses where slug = 'acme-roofing';

-- retire a job type (existing jobs keep showing its name)
update job_types set active = false
 where name = 'Inspection' and business_id = (select id from businesses where slug = 'acme-roofing');

-- rename a status label (keep the key)
update statuses set label = 'Invoiced'
 where key = 'paid' and business_id = (select id from businesses where slug = 'acme-roofing');

-- brand color
update businesses set accent_color = '#166534' where slug = 'acme-roofing';

-- wording ("Customer" instead of "Client")
update businesses
   set terms = '{"client":"Customer","clients":"Customers","job":"Job","jobs":"Jobs"}'
 where slug = 'acme-roofing';
```

## Data export

- In the app: status bar → **Details → Download my data (spreadsheet)** (needs signal).
- From your computer: `npm run export -- <business-slug> [--format csv|json]` → `exports/` (git-ignored — it contains customers' phone numbers).

CSV has one row per job (clients with no jobs get one row) and is safe to open in Excel/Sheets: cells that start with `=`, `+`, `-` or `@` are neutralized.

## How the offline sync works

- Each phone keeps a full copy of its business's clients and jobs in IndexedDB. Lookups and the client card read **only** that copy, so they're instant and work with no signal.
- Every add/edit is saved locally *and* queued in one step. The queue is sent to the server in order whenever there's signal (app open, signal returns, every minute, or **Sync now**). Every write is idempotent — ids are created on the phone — so a request that's retried after a dropped connection can never duplicate anything.
- After sending, the phone downloads what changed on the server.
- The first sign-in on a phone must have signal (to download the data). Until that finishes the app says "Downloading…" and never shows NEW CLIENT, since that could be wrong.

**Conflict rules**

- The same phone number is always one client. If two phones add the same number offline, the server keeps the first record and both phones' jobs are merged onto it (the second phone's typed name is dropped).
- Other edits: last change to reach the server wins. Tapping a status several times offline sends only the final one. Edits send only the fields you changed.
- A pull never overwrites something you changed on this phone that hasn't been sent yet.
- If the server rejects a change (for example a job type was retired in the meantime) it's set aside, the rest keeps syncing, and the status bar shows **needs attention** with **Discard** / **Try again**.

The status bar always tells the truth: **Synced**, **Syncing…**, **Offline · N waiting**, or **needs attention**.

## Security

- Tenant identity comes **only** from the server-side session — never from request bodies, query strings or URLs. Every query filters on it, and composite foreign keys `(business_id, id)` make cross-tenant links impossible even if code had a bug. The test suite tries to read and write across tenants and must fail every time.
- PINs are hashed with scrypt. Login is rate-limited (5 wrong tries per address+business, 20 per business, per 15 minutes) and wrong-PIN / unknown-business look identical.
- Sessions are random 256-bit tokens (only their hash is stored) in an `HttpOnly; Secure; SameSite=Strict` cookie, 30 days.
- All input is validated server-side; all SQL is parameterized. Mutations must be `application/json` and same-origin.
- HTTPS-only (HSTS), strict Content-Security-Policy, no third-party scripts or fonts.
- Secrets live only in environment variables.

## Known limits / good to know

- One PIN per business (no per-person crews in v1). Signing out clears the phone's local copy (it warns if anything hasn't synced).
- Phone numbers are US-style, 10 digits.
- Adding to the Home Screen matters on iPhone: Safari may clear a website's stored data after about 7 days without use, but an installed home-screen app is exempt. Install it.
- The home-screen name comes from the business name; iPhone shortens long names.
- Job types, status labels, colors and wording are changed with SQL for now (no admin screen).
- The bulk download is paged at 5,000 rows per request; far beyond a typical tradesperson's list.

## Scripts

| Command | Does |
| --- | --- |
| `npm run dev` / `build` / `preview` | Local dev server (with API) / production build / preview it |
| `npm run migrate` | Apply SQL migrations to `DATABASE_URL` |
| `npm run seed` | Create the Deno Fence and Stain tenant (needs `DENO_PIN`) |
| `npm run onboard` | Create a business from a preset and set its PIN |
| `npm run set-pin -- <slug>` | Change a business's PIN |
| `npm run export -- <slug>` | Export a business's data |
| `npm test` | All tests (dev database only) |

## Troubleshooting

- **"Can't reach the server" / stuck on Offline with signal** — tap the status bar → **Sync now**. If it persists, check the Netlify function logs for `api` and that `DATABASE_URL` is set for that deploy context.
- **Sign-in says "Wrong business or PIN"** — the Business ID is the slug (e.g. `deno-fence-and-stain`), not the display name. Reset the PIN with `npm run set-pin`.
- **"Too many attempts"** — wait 15 minutes.
- **Phone shows an old version of the app** — close it fully and reopen with signal; the new version loads on the next launch.
- **Tests skipped** — they need `DATABASE_URL` (dev branch) in `.env`.
