# Uptime Watch

A self-hosted website downtime tracker: a Bootstrap 5 dashboard on top of a small
Node.js/Express backend that actually pings your sites (and individual pages on
each site), records real HTTP status codes, runs its own live-adjustable
scheduler, and emails you the moment something goes down.

Everything here is a real, running app — the "Add website" / "Remove" buttons in
the UI genuinely add and remove sites from monitoring (saved permanently to a
Postgres database), not just a visual mockup.

## What it does

- **Homepage**: a collective analytics overview (monitored/up/down counts, median
  and average uptime %, median and average response time across every site, total
  pages tracked) above a filterable, searchable grid of site cards.
- **Add one site, or many at once** — the "Add website" modal has a bulk mode:
  paste a list of URLs (one per line, optionally `Name, URL`) and they're all
  added and checked immediately.
- **Click any site card** to open its detail page: analytics for a date range you
  choose (today / 7 days / 30 days / all time / custom), a response-time chart
  (points colored by status), a day-by-day summary you can expand to see every
  individual check — time, status, HTTP code, response time — with its own status
  filter, and the list of **pages tracked under that site**.
- **Track individual pages, not just the homepage** — from any site's detail
  page, click "+ Add page" to monitor a specific URL on that site (e.g. `/pricing`,
  `/checkout`) separately from the site's root. Each page gets its own status,
  history, and analytics page (click into it just like a site), and is checked
  on the same schedule as everything else. Remove a page any time without
  touching the site it belongs to.
- **Adjustable schedule** — a Settings panel (gear icon) lets you change how often
  everything is checked (5 minutes up to once a day, or a custom cron expression)
  without editing any file or restarting the app; it takes effect immediately.
- Records the **actual HTTP status code** — 200, 301, 404, 500, timeouts, DNS
  failures, connection refused, etc. — and classifies each as Up / Warning / Down.
- Sends an email the moment a site or page goes down, and another when it recovers.
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
   | `CHECK_INTERVAL_CRON` | `0 * * * *` |
   | `SMTP_HOST` | `smtp.gmail.com` |
   | `SMTP_PORT` | `587` |
   | `SMTP_SECURE` | `false` |
   | `SMTP_USER` | `pash@allpracticesolutions.com` |
   | `SMTP_PASS` | *(the app password from Part 3 below)* |
   | `ALERT_FROM_EMAIL` | `pash@allpracticesolutions.com` |
   | `ALERT_TO_EMAIL` | `pash@allpracticesolutions.com` |
   | `DASHBOARD_USER` | *(pick a username)* |
   | `DASHBOARD_PASS` | *(pick a strong password)* |

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

### Part 3 — Create a Gmail/Google Workspace app password

Since `pash@allpracticesolutions.com` is on Google Workspace:

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
lib/checker.js      Does the actual HTTP request and classifies the result
lib/monitor.js       Runs a check for one/all sites & pages, decides when to alert
lib/mailer.js         Sends the email alert via SMTP (nodemailer)
lib/store.js           Postgres-backed data layer (sites, pages, checks, settings, analytics, .xlsx export)
public/index.html    Homepage — collective analytics + filterable site grid
public/site.html       Site/page detail page — date-range analytics, chart, daily summary, pages list
public/app.js          Homepage logic (analytics, filters, add/bulk-add, settings)
public/site.js           Detail page logic (site or page scope, date range, chart, daily summary, page add/remove)
public/shared.js           Helpers shared by both pages
public/style.css             Styling on top of Bootstrap
```

## API (for reference / scripting)

- `GET /api/analytics` — collective stats across all sites (median/average uptime %, median/average response time, up/warning/down counts, total pages tracked)
- `GET /api/export` — download a fresh `.xlsx` snapshot of everything in the database
- `GET /api/sites` — list all sites with their latest status + 7-day uptime stats
- `POST /api/sites` — add a single site `{ name?, url }` (checks it immediately)
- `POST /api/sites/bulk` — add many sites at once `{ entries: [{ name?, url }, ...] }`
- `GET /api/sites/:id` — one site's current status
- `DELETE /api/sites/:id` — remove a site (and its pages and check history)
- `GET /api/sites/:id/history?from=&to=&limit=` — raw check history for the site's own root URL, optionally date-filtered
- `GET /api/sites/:id/analytics?from=&to=` — uptime %, avg/median response time, incidents, day-by-day summary, and the chart series for a date range
- `POST /api/sites/:id/check` — check one site's root URL right now
- `GET /api/sites/:id/pages` — list pages tracked under a site
- `POST /api/sites/:id/pages` — add a single page `{ name?, url }` under a site (checks it immediately)
- `POST /api/sites/:id/pages/bulk` — add many pages at once `{ entries: [{ name?, url }, ...] }`
- `GET /api/sites/:id/pages/:pageId` — one page's current status
- `DELETE /api/sites/:id/pages/:pageId` — remove a page (and its check history)
- `GET /api/sites/:id/pages/:pageId/analytics?from=&to=` — same shape as the site analytics endpoint, scoped to that page
- `POST /api/sites/:id/pages/:pageId/check` — check one page right now
- `POST /api/check-all` — check every site and page right now (this is what an external scheduler pings)
- `GET /api/settings` / `PUT /api/settings` — read or change the check schedule (`checkIntervalCron`) and `requestTimeoutMs`; a `PUT` reschedules the live scheduler immediately

All endpoints require HTTP Basic Auth if `DASHBOARD_USER`/`DASHBOARD_PASS` are set.
