# Uptime Watch

A self-hosted website downtime tracker: a Bootstrap 5 dashboard on top of a small
Node.js/Express backend that actually pings your sites, records real HTTP status
codes, runs its own live-adjustable scheduler, and emails you the moment something
goes down.

Everything here is a real, running app — the "Add website" / "Remove" buttons in
the UI genuinely add and remove sites from monitoring (saved to an Excel workbook
on disk), not just a visual mockup.

## What it does

- **Homepage**: a collective analytics overview (monitored/up/down counts, median
  and average uptime %, median and average response time across every site) above
  a filterable, searchable grid of site cards.
- **Add one site, or many at once** — the "Add website" modal has a bulk mode:
  paste a list of URLs (one per line, optionally `Name, URL`) and they're all
  added and checked immediately.
- **Click any site card** to open its detail page: analytics for a date range you
  choose (today / 7 days / 30 days / all time / custom), a response-time chart
  (points colored by status), and a day-by-day summary you can expand to see every
  individual check — time, status, HTTP code, response time — with its own status
  filter.
- **Adjustable schedule** — a Settings panel (gear icon) lets you change how often
  sites are checked (5 minutes up to once a day, or a custom cron expression)
  without editing any file or restarting the app; it takes effect immediately.
- Records the **actual HTTP status code** — 200, 301, 404, 500, timeouts, DNS
  failures, connection refused, etc. — and classifies each as Up / Warning / Down.
- Sends an email the moment a site goes down, and another when it recovers.
- Optional HTTP Basic Auth so the dashboard isn't wide open once it's on the internet.

---

## Option A — Run it on your own computer

**1. Install Node.js** (once): download the LTS version from nodejs.org and run
the installer with defaults.

**2. Unzip** this project, open a terminal in the `downtime-tracker` folder, then:

```bash
npm install
cp .env.example .env      # Windows: copy .env.example .env
npm start
```

Open **http://localhost:3000**. Fill in the SMTP section of `.env` (see "Email
alerts" below) if you want down-alert emails; everything else works without it.

---

## Option B — Host it for free on Render.com (recommended if you don't want to keep your computer running)

This keeps the list private (private GitHub repo + password-protected dashboard)
and doesn't cost anything. It's three short parts.

### Part 1 — Put the code on GitHub (no command line needed)

1. Go to **github.com/signup** and create a free account.
2. Once logged in, click the **+** in the top-right corner → **New repository**.
   Name it `uptime-watch`, set visibility to **Private**, and click **Create repository**.
3. On the next page, click **"uploading an existing file"**.
4. Unzip this project on your computer, then drag the *entire* `downtime-tracker`
   folder's contents (all the files and the `lib`/`public`/`data` folders) into
   the upload box. Wait for the upload to finish, then click **Commit changes**.

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
asleep when it would normally have fired.

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

Everything lives in a single Excel workbook at `data/uptime-data.xlsx` — open it
directly in Excel/Google Sheets/Numbers any time (close it before the app writes
to it again, since most spreadsheet apps lock the file while open). It has three
sheets:

- **Sites** — every site you're tracking (id, name, url, added date)
- **Checks** — every recorded check (site, timestamp, status, HTTP code, response
  time, error) — capped at the most recent 5,000 checks per site so the file
  doesn't grow forever
- **Settings** — the current check schedule and request timeout, editable live
  from the dashboard's Settings panel

On Render's free tier, this file resets on redeploys/restarts since there's no
persistent disk — it should survive normal sleep/wake cycles fine, but if that
matters to you, Render's paid tiers add persistent disks, or ask me and I can
wire this up to a free database instead.

## Project structure

```
server.js          Express app, REST API, basic auth, and the live scheduler
lib/checker.js      Does the actual HTTP request and classifies the result
lib/monitor.js       Runs a check for one/all sites, decides when to alert
lib/mailer.js         Sends the email alert via SMTP (nodemailer)
lib/store.js           Excel-backed data layer (sites, checks, settings, analytics)
public/index.html    Homepage — collective analytics + filterable site grid
public/site.html       Site detail page — date-range analytics, chart, daily summary
public/app.js          Homepage logic (analytics, filters, add/bulk-add, settings)
public/site.js           Detail page logic (date range, chart, daily summary)
public/shared.js           Helpers shared by both pages
public/style.css             Styling on top of Bootstrap
```

## API (for reference / scripting)

- `GET /api/analytics` — collective stats across all sites (median/average uptime %, median/average response time, up/warning/down counts)
- `GET /api/sites` — list all sites with their latest status + 7-day uptime stats
- `POST /api/sites` — add a single site `{ name?, url }` (checks it immediately)
- `POST /api/sites/bulk` — add many sites at once `{ entries: [{ name?, url }, ...] }`
- `GET /api/sites/:id` — one site's current status
- `DELETE /api/sites/:id` — remove a site (and its check history)
- `GET /api/sites/:id/history?from=&to=&limit=` — raw check history, optionally date-filtered
- `GET /api/sites/:id/analytics?from=&to=` — uptime %, avg/median response time, incidents, day-by-day summary, and the chart series for a date range
- `POST /api/sites/:id/check` — check one site right now
- `POST /api/check-all` — check every site right now (this is what an external scheduler pings)
- `GET /api/settings` / `PUT /api/settings` — read or change the check schedule (`checkIntervalCron`) and `requestTimeoutMs`; a `PUT` reschedules the live scheduler immediately

All endpoints require HTTP Basic Auth if `DASHBOARD_USER`/`DASHBOARD_PASS` are set.
"# uptimewatch" 
