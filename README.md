# Uptime Watch

A self-hosted website downtime tracker: a Bootstrap 5 dashboard on top of a small
Node.js/Express backend that actually pings your sites (and individual pages on
each site), records real HTTP status codes, runs its own live-adjustable
scheduler, and emails you the moment something goes down.

Everything here is a real, running app — the "Add website" / "Remove" buttons in
the UI genuinely add and remove sites from monitoring (saved permanently to a
Postgres database), not just a visual mockup.

## What it does

- **Homepage**: a collective analytics overview (monitored/up/down/slow counts,
  average uptime %, average response time across every site, total pages
  tracked) above a filterable, searchable grid of site cards — each showing how
  many pages are tracked under it.
- **A site's status is never just its homepage's status.** Every site card (and
  the site's own detail page) shows one combined status computed across the root
  URL **and every page tracked under it**: all of them healthy (up or slow) →
  **Up**, or **Slow** if any of them were slow; none of them healthy at all →
  **Down**; anything in between (say, the homepage is fine but one inner page is
  erroring) → **Warning**. The card's detail line spells out the actual
  breakdown — e.g. "8 up · 1 slow · 1 down" — instead of hiding it behind a
  single badge, and the homepage's overview counts are built from this same
  combined status, not from root-URL checks alone.
- **"Slow" is not "Down".** A 500 error, a timeout, or a connection failure
  is a real availability failure and is always classified **Down** — it blocks
  users completely. A page that returns a normal 200 OK but takes longer than
  the configured slow threshold (Settings → "Slow threshold") is classified
  **Slow** instead — a performance problem the user can still work around, not
  an outage. These are shown with distinct badges/colors everywhere (site
  cards, the detail page's chart and daily log, the digest email) specifically
  so a team glancing at the dashboard never mistakes "a bit slow today" for
  "the site is down".
- **Add one site, or many at once** — the "Add website" modal has a bulk mode:
  paste a list of URLs (one per line, optionally `Name, URL`) and they're all
  added and checked immediately.
- **Pages are discovered automatically** — when you add a site, it's scanned in
  the background (its sitemap first, or the links on its homepage if it doesn't
  publish one) and up to 25 of its pages are added and start being tracked, with
  names taken from each page's own `<title>`. No need to add pages one by one.
  Any site can be re-scanned any time from its detail page ("Scan for pages") to
  pick up newly added pages — it only ever adds new ones, never touches or
  duplicates pages you already have.
- **Click any site card** to open its detail page. The page leads with
  analytics: combined stats (the site's root URL plus every page under it) for a
  date range you choose (today / 7 days / 30 days / all time / custom), a
  response-time chart (points colored by status), and a day-by-day summary you
  can expand to see every individual check — time, which page it was, status,
  HTTP code, response time — with its own status filter. **Pages on this site**
  follows underneath as its own collapsible section (click the header to
  open/close it, same as the daily summary's day-cards) — a filterable
  (All/Up/Warning/Down) list-style table of every page tracked under that site,
  each row clickable through to its own detail view. On a page's own detail
  view, "‹ Prev / Next ›" arrows let you click through every page on that site
  one after another without going back to the list each time.
- **Adjustable schedule** — a Settings panel (gear icon) lets you change how often
  everything is checked (5 minutes up to once a day, or a custom cron expression)
  without editing any file or restarting the app; it takes effect immediately.
- Records the **actual HTTP status code** — 200, 301, 404, 500, timeouts, DNS
  failures, connection refused, etc. — and classifies each as Up / Slow / Warning / Down.
- **One consolidated digest email per check cycle** — instead of a separate
  email for every individual page transition (which gets unmanageable fast once
  you're tracking dozens of pages), Uptime Watch sends a single report each time
  the scheduler runs, listing every site/page currently Down, Warning, or Slow
  (grouped by severity, worst first), plus anything that just recovered. It
  fires every cycle for as long as a problem persists — not just once when it
  first appears — so the report in your inbox always matches reality. Subject
  lines are precise: a single issue reads like `DOWN - example.com | HTTP 500`;
  multiple issues summarize as `WARNING - 2 WARNING, 1 SLOW`; an all-clear reads
  `UP - example.com is back up`.
- **Alert recipients are set from the dashboard**, not a fixed config file —
  gear icon → Settings → "Alert recipients" takes a comma-separated list of
  email addresses and takes effect on the next check, no redeploy needed.
- **"Mark as Fixed"** — every problem row in the digest email (and the "Mark as
  Fixed" button on a site/page's own detail page) lets you silence that one
  target's alerts immediately, without waiting for the next check to confirm
  it. Clicking it takes you straight to that site/page in the dashboard. The
  silence only lasts until the *next* automatic check, though — if the
  underlying problem isn't actually fixed, it reappears in the very next
  report, so acknowledging something never permanently hides a real issue.
- **Mail log** — the small mail icon next to Settings opens a log of every
  digest email attempt: when it was sent, its subject, who it went to, and
  whether it actually succeeded (so a misconfigured mail provider is visible
  in the dashboard, not just buried in server logs).
- **"Check now" checks everything under a site** — on a site's own dashboard,
  it re-checks the root URL and every page under it in one go, and the results
  show up immediately in that site's combined daily summary.
- **Download an Excel backup any time** — the Settings panel has a "Download
  backup (.xlsx)" button that exports everything currently in the database
  (sites, pages, checks, settings) as a spreadsheet.
- Optional HTTP Basic Auth so the dashboard isn't wide open once it's on the internet.

---

## Option A — Run it on your own computer

**1. Install Node.js** (once): download the LTS version from nodejs.org and run
the installer with defaults.

**2. Get a free Postgres database.** This app needs `DATABASE_URL` set even for
local use — see "Part 0" below for the free Neon setup (takes about 2 minutes).

**3. Unzip** this project, open a terminal in the `downtime-tracker` folder, then:

```bash
npm install
cp .env.example .env      # Windows: copy .env.example .env
# edit .env and paste your DATABASE_URL
npm start
```

Open **http://localhost:3000**. Fill in the SMTP section of `.env` (see "Email
alerts" below) if you want down-alert emails; everything else works without it.

---

## Option B — Host it for free on Render.com (recommended if you don't want to keep your computer running)

This keeps the list private (private GitHub repo + password-protected dashboard),
survives restarts/redeploys, and doesn't cost anything. It's four short parts.

### Part 0 — Create a free Postgres database on Neon

This is what makes your data permanent — without it, anything stored only on
Render's disk gets wiped whenever the free container restarts.

1. Go to **neon.tech** and sign up for a free account.
2. Create a new project (any name/region is fine — the free tier is generous
   enough for this app).
3. On the project dashboard, find the **Connection string** (it looks like
   `postgresql://user:password@ep-xxxx.neon.tech/neondb?sslmode=require`) and
   copy it. You'll paste this into Render's environment variables in Part 2 as
   `DATABASE_URL`.

That's it — the app creates its own tables automatically the first time it
connects, so there's nothing else to set up on Neon's side.

### Part 1 — Put the code on GitHub (no command line needed)

1. Go to **github.com/signup** and create a free account.
2. Once logged in, click the **+** in the top-right corner → **New repository**.
   Name it `uptime-watch`, set visibility to **Private**, and click **Create repository**.
3. On the next page, click **"uploading an existing file"**.
4. Unzip this project on your computer, then drag the *contents* of the
   `downtime-tracker` folder (all the files and the `lib`/`public` folders — not
   the `downtime-tracker` folder itself) into the upload box. Wait for the upload
   to finish, then click **Commit changes**.

### Part 2 — Deploy it on Render (free tier)

1. Go to **render.com** and sign up — choose **"Sign up with GitHub"** so the
   two accounts connect automatically.
2. When prompted, grant Render access to your `uptime-watch` repository
   (choose "Only select repositories").
3. In the Render dashboard, click **New +** → **Web Service**, and pick your
   `uptime-watch` repo.
4. Fill in:
   - **Name**: `uptime-watch` (or anything you like)
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: **Free**
5. Before clicking create, open **"Environment Variables"** and add these
   (values explained below):

   | Key | Value |
   |---|---|
   | `DATABASE_URL` | *(the connection string you copied from Neon in Part 0)* |
   | `APP_BASE_URL` | `https://<your-render-url>.onrender.com` *(fill this in after your first deploy — see note below)* |
   | `CHECK_INTERVAL_CRON` | `0 * * * *` |
   | `MJ_API_KEY` | *(your Mailjet API key — see the important note below)* |
   | `MJ_API_SECRET` | *(your Mailjet secret key)* |
   | `ALERT_FROM_EMAIL` | *(the sender email you verified in Mailjet)* |
   | `ALERT_TO_EMAIL` | `pash@allpracticesolutions.com` *(just the first-boot default — see note below)* |
   | `DASHBOARD_USER` | *(pick a username)* |
   | `DASHBOARD_PASS` | *(pick a strong password)* |

   `APP_BASE_URL` is only used to build absolute links in the digest email
   (the "Mark as Fixed" and site-detail links) — email clients can't resolve a
   relative link the way a browser can, so without this set those links won't
   work from an inbox. Render only assigns your `https://....onrender.com` URL
   *after* the first deploy, so create the service first, copy the URL it
   gives you, then come back and add `APP_BASE_URL` as an environment variable
   (Render redeploys automatically when you save it).

   `ALERT_TO_EMAIL` only seeds the recipient list the very first time the app
   boots against a brand-new database — after that, the database is the
   source of truth and the real place to manage recipients is the dashboard's
   gear icon → Settings → **Alert recipients** (comma-separated, editable any
   time, no redeploy needed).

   **Important — Render's free tier blocks plain SMTP.** Render blocks all
   outbound traffic on ports 25/465/587 (what SMTP uses) on its free instance
   type, so `SMTP_HOST`/`SMTP_USER`/`SMTP_PASS`-style setups (including a
   Gmail app password — see Part 3 below) will just time out and silently
   fail to send here. Use `MJ_API_KEY`/`MJ_API_SECRET` instead: that's
   Mailjet's HTTPS API, which rides over the same port (443) your dashboard
   already uses, so it isn't affected by that block. Sign up free at
   mailjet.com (no credit card, 6,000 emails/month), verify a sender email
   under **Account Settings → Sender addresses & domains** (click the
   confirmation link Mailjet emails you), then grab both keys under
   **Account Settings → API Key Management**. If you're running this app
   somewhere that doesn't block outbound SMTP (your own computer, a paid
   Render instance, most other hosts), the `SMTP_*` variables from Part 3
   work fine instead — just leave `MJ_API_KEY`/`MJ_API_SECRET` blank in that
   case. (Brevo's API also works as a `BREVO_API_KEY` alternative, but note
   it requires an active plan with email credits remaining — including its
   free plan — or sends will silently fail with an "insufficient credits"
   error even though everything else is configured correctly.)

6. Click **Create Web Service**. Render will build and deploy — after a couple
   of minutes you'll get a URL like `https://uptime-watch-xxxx.onrender.com`.
   Opening it will now prompt for the `DASHBOARD_USER`/`DASHBOARD_PASS` you set.

**Note:** Render's free tier spins the service down after 15 minutes with no
traffic, and wakes back up (in ~30–50 seconds) on the next request. That's what
Part 4 (the free scheduler ping) is for — it hits the app every hour, which both
wakes it up and reliably triggers a check even if the built-in scheduler was
asleep when it would normally have fired. Because your data now lives in Neon
rather than on Render's disk, none of this sleep/wake/redeploy cycle can wipe it
anymore.

### Part 3 — Create a Gmail/Google Workspace app password (only if NOT using Render's free tier)

Skip this if you're on Render's free tier and used `BREVO_API_KEY` above —
this is the plain-SMTP alternative for local use or hosts that don't block
outbound SMTP. Since `pash@allpracticesolutions.com` is on Google Workspace:

1. Go to **myaccount.google.com/security** and make sure **2-Step Verification**
   is turned on (required for app passwords).
2. Go to **myaccount.google.com/apppasswords**, sign in again if asked, name it
   "Uptime Watch", and click **Create**.
3. Copy the 16-character password shown and use it as `SMTP_PASS` in Part 2.

If `apppasswords` isn't reachable, your Workspace admin may have disabled app
passwords org-wide — in that case, ask your admin to enable them for your
account, or use a different email address for alerts instead.

### Part 4 — Keep it awake & trigger the hourly check reliably

1. Go to **cron-job.org** and create a free account.
2. Click **Create cronjob**. Set:
   - **URL**: `https://<your-render-url>/api/check-all`
   - **Schedule**: every hour
   - **Request method**: POST
   - Under **Advanced → Authentication**, choose **Basic Auth** and enter the
     same `DASHBOARD_USER` / `DASHBOARD_PASS` you set on Render.
3. Save it. From now on, this pings your app every hour, which both wakes it
   from sleep and runs the check.

---

## How the data is stored

Everything (sites, pages, check history, settings) lives in a Postgres database
— on Neon's free tier if you followed the guide above, so it's not tied to
Render's disk and survives sleep/wake cycles, redeploys, and restarts.

Want a spreadsheet copy any time — to look through in Excel, archive, or just as
a second backup? Click the gear icon → **Download backup (.xlsx)** on the
homepage, or hit `GET /api/export` directly. It generates a fresh 4-sheet
workbook (Sites, Pages, Checks, Settings) from whatever is currently in the
database.

## Project structure

```
server.js          Express app, REST API, basic auth, and the live scheduler
lib/checker.js      Does the actual HTTP request and classifies the result (Up/Slow/Warning/Down)
lib/discover.js       Auto-discovers a site's pages (sitemap, or homepage-link crawl fallback)
lib/monitor.js          Runs a check for one/all sites & pages, tracks recoveries, triggers the digest
lib/digest.js             Builds & sends the one consolidated report email per check cycle, logs it
lib/mailer.js               Sends a single email via Mailjet/Brevo's HTTPS API or SMTP (nodemailer)
lib/store.js                  Postgres-backed data layer (sites, pages, checks, settings, mail log, analytics, .xlsx export)
public/index.html    Homepage — collective analytics + filterable site grid + Settings + Mail log
public/site.html       Site/page detail page — date-range analytics, chart, daily summary, pages list
public/app.js          Homepage logic (analytics, filters, add/bulk-add, settings, mail log)
public/site.js           Detail page logic (site or page scope, date range, chart, daily summary, page add/remove/scan, prev/next nav, mark as fixed)
public/shared.js           Helpers shared by both pages
public/style.css             Styling on top of Bootstrap
```

## API (for reference / scripting)

- `GET /api/analytics` — collective stats across all sites (average uptime %, average response time, up/slow/warning/down counts, total pages tracked)
- `GET /api/export` — download a fresh `.xlsx` snapshot of everything in the database
- `GET /api/mail-log?limit=` — recent digest email attempts (timestamp, subject, recipients, success/failure)
- `GET /api/sites` — list all sites with their latest status + 7-day uptime stats + `pageCount`, plus the combined-status fields `aggregateStatus` (`up`/`slow`/`warning`/`down`/`unknown`) and `targetsUp`/`targetsSlow`/`targetsWarning`/`targetsDown`/`targetsTotal` — the breakdown across the root URL and every page under it (see "A note on site-wide status" below)
- `POST /api/sites` — add a single site `{ name?, url }` (checks it immediately, then scans it for pages in the background)
- `POST /api/sites/bulk` — add many sites at once `{ entries: [{ name?, url }, ...] }` (each is scanned for pages in the background too)
- `GET /api/sites/:id` — one site's current status
- `DELETE /api/sites/:id` — remove a site (and its pages and check history)
- `POST /api/sites/:id/acknowledge` — "Mark as Fixed" for the site's root URL; silences its alerts/status until the next automatic check records a newer result
- `GET /api/sites/:id/ack` — same action as a plain GET that redirects into the site's detail page afterward (what the digest email's "Mark as Fixed" link points at, since email links can only ever be GET)
- `GET /api/sites/:id/history?from=&to=&limit=` — raw check history for the site's own root URL, optionally date-filtered
- `GET /api/sites/:id/analytics?from=&to=` — combined uptime %/avg response time/incidents/day-by-day summary/chart series for the site's root URL **and every page under it**, for a date range
- `POST /api/sites/:id/check` — check one site's root URL right now (root only — see `check-all` below to include its pages)
- `POST /api/sites/:id/check-all` — check the site's root URL AND every page under it right now (what the site dashboard's "Check now" button calls)
- `POST /api/sites/:id/scan-pages` — re-scan the site for pages and add any newly found ones; pages already tracked are left untouched (never duplicated)
- `GET /api/sites/:id/pages` — list pages tracked under a site
- `POST /api/sites/:id/pages` — add a single page `{ name?, url }` under a site (checks it immediately)
- `POST /api/sites/:id/pages/bulk` — add many pages at once `{ entries: [{ name?, url }, ...] }`
- `GET /api/sites/:id/pages/:pageId` — one page's current status
- `DELETE /api/sites/:id/pages/:pageId` — remove a page (and its check history)
- `POST /api/sites/:id/pages/:pageId/acknowledge` — "Mark as Fixed" for a single page, scoped independently of its site's root URL
- `GET /api/sites/:id/pages/:pageId/ack` — same, as a GET-redirect for the email link
- `GET /api/sites/:id/pages/:pageId/analytics?from=&to=` — that page's own analytics only (not combined with the rest of the site)
- `POST /api/sites/:id/pages/:pageId/check` — check one page right now
- `POST /api/check-all` — check every site and page right now, and send the digest email if anything needs reporting (this is what an external scheduler pings)
- `GET /api/settings` / `PUT /api/settings` — read or change the check schedule (`checkIntervalCron`), `requestTimeoutMs`, `slowThresholdMs` (a successful response slower than this is classified Slow instead of Up), and `alertRecipients` (comma-separated digest recipients); a `PUT` applies all of these immediately, no restart needed

All endpoints require HTTP Basic Auth if `DASHBOARD_USER`/`DASHBOARD_PASS` are set.

### A note on site-wide status

A site's badge is computed from **every target under it** — the root URL plus
each tracked page — not from the root URL alone. Concretely: if every target
is healthy (up or slow), the site shows **Up**, or **Slow** if any of them
were slow; if nothing at all is healthy, it shows **Down**; any mix — even
just one page erroring while everything else, including the homepage, is
fine — shows **Warning**. This is intentional: a site with a healthy homepage
but a broken contact page is a real partial problem, and the old approach
(root-URL-only) would have hidden it behind a green "Up" badge. This same rule
drives the homepage's site cards, its filter buttons, its overview counts, and
the badge at the top of the site's own detail page.

### A note on Slow vs. Down

These are deliberately kept separate everywhere in the app, because they mean
different things to your team:

- **Down** is an availability failure: a 500-range server error, a timeout, or
  a connection failure (DNS, refused, reset, TLS). It blocks users completely,
  and is always Down no matter how close to completing the request was.
- **Slow** is a performance degradation: the request actually succeeded (a
  2xx/3xx response), just slower than the configured slow threshold (Settings
  → "Slow threshold (ms)", 3 seconds by default). Users can still finish what
  they came to do, just with more friction/wait.

A Slow result still counts as "available" for uptime% purposes (it did
succeed), but is broken out separately everywhere — the status badges, the
chart's point colors and legend, the daily log's filter, the homepage's
overview tile, and the digest email's own "SLOW" section — so "the checkout
page is loading slowly today" is never confused with "the checkout page is
down".

### A note on the digest email & "Mark as Fixed"

Every time a check cycle finishes — the scheduler, the homepage's "Check all"
button, or server boot (but deliberately *not* a single site/page's own "↻"
recheck button, so those stay quiet) — Uptime Watch looks at every target's
CURRENT status and, if anything is Down/Warning/Slow or just recovered, sends
one report covering all of it. It's a "fixed-schedule" digest: it fires every
cycle a problem persists, not only the first time it's noticed, so the report
in your inbox is never stale.

Clicking **Mark as Fixed** — in the email, on a site's detail page, or on a
page's own row in the "Pages on this site" table — records an acknowledgment
timestamp on that specific target. As long as that timestamp is newer than
the target's latest recorded check, the dashboard and digest both treat it as
**Up**, regardless of what the check itself actually returned. The moment the
*next* automatic check runs, its own fresh timestamp takes over and the real
result applies again — so a genuinely still-broken site reappears in the very
next digest, and "Mark as Fixed" can never be used to permanently silence a
real, ongoing problem.

### A note on automatic page discovery

Adding a site (or clicking "Scan for pages" on one you already have) tries to
fetch its `sitemap.xml` first — checking `robots.txt` for a `Sitemap:` line as
well as the usual `/sitemap.xml` and `/sitemap_index.xml` locations — since
that's the site's own authoritative list of pages. If none is published, it
falls back to scanning the links on the homepage instead. Either way, the list
is capped at 25 pages per scan, favoring shallower, more "main navigation"
looking pages (like `/services` or `/locations/downtown`) over deep or
blog/archive-style ones (`/blog/post-42`, `/tag/...`) when there are more
candidates than the cap allows. This is a heuristic, not a guarantee — for a
site with an unusual structure, or pages you specifically want that didn't
make the cut, "+ Add page" still lets you add anything by hand.
