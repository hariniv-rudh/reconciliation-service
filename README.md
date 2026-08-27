# FMCG Reconciliation Service

The external script the Kissflow app depends on. This account has no HTTP/Webhook
connector available, so Kissflow can't push a "Reconcile was clicked" event to us —
instead, this service **polls** Kissflow every minute for any Reconciliation Run that's
been submitted but not yet processed, picks it up, downloads the two uploaded files,
parses and matches them, and writes the results back into the Kissflow app.

## What it does

Every `POLL_INTERVAL_MS` (default 60s), it:
1. Fetches recent Reconciliation Run items and finds any whose `Status` field is still
   blank (a freshly-submitted run that nothing has claimed yet — Finance can't set that
   field themselves, and it has no default, so blank genuinely means "new").
2. Immediately sets that run's Status to `Processing` — this is the claim that stops a
   slow run from being picked up twice by the next tick.
3. Looks up its Bank Master (parsing rule + code mapping) and every Terminal/Store Master
   record, downloads the uploaded Bank Statement and Sales Report files.
4. Parses the bank statement (`src/parseBankStatement.js`) using the bank's configured
   extraction rule, and the sales report (`src/parseSalesReport.js`) tab by tab.
5. Matches them at STORE + NETWORK + DAY grain with the T+1 settlement lag
   (`src/reconcile.js`), creates the Reconciliation Line + Terminal Settlement Detail
   records, and sets the Run's status to `Reconciled` (or `Failed` if anything throws).

Kissflow's own automations (built manually in the builder, since this account also has no
internal Process/Board/Form connector — see the note in the parent app's decisions.md) take
it from there once a Reconciliation Line is flagged.

**Reconciliation Run's business fields (Bank, Period, uploaded files, Status) are only
readable through Kissflow's "(Admin)" Process API family** (`kf.getProcessItem`/
`kf.listProcessItems` in `src/kissflow.js`) — the plain process endpoints (`myitems`, a
direct item fetch) only ever expose workflow metadata like status/step/assignee, never
actual field values, confirmed against Kissflow's own official API docs. These Admin
endpoints require the access key's user to have **Process Admin** rights on this flow —
the account admin key already used throughout this build qualifies, so nothing extra to
configure, but keep this in mind if the key ever changes.

## Before you deploy — things to verify with real data

This was built and unit-tested against your real sample files, but a few things depend on
exactly how Kissflow shapes its API responses, which can only be confirmed once this is
wired to the live app:

1. **Attachment field shape** (`src/server.js`, `bankStatementUrl`/`salesReportUrl`). Trigger
   a test run, log `JSON.stringify(run.bank_statement_file)`, and adjust the property name
   used to grab the download URL if it doesn't match what's assumed.
2. **Bank Master's child-table property name** (`src/server.js`, the `codeMap` line). Fetch
   a real Bank Master record and log it once to see what key its "Bank Statement Code
   Mapping" rows live under, then fix that one line.
3. **The "blank Status = unprocessed" assumption** (`src/server.js`, `pollOnce()`). Submit
   one test Reconciliation Run and log what its `status` field actually reads back as before
   this service touches it (`undefined`? `null`? `""`?) — the filter `!r.status` should catch
   all of those, but confirm rather than assume, especially once you've manually built the
   automations elsewhere in the builder (make sure none of them accidentally stamp a default
   Status value on creation, which would make every new run look "already claimed").

None of these are structural — they're all one-line fixes once you can see a real payload.

## Setup

```bash
npm install
cp .env.example .env
# fill in KF_ACCESS_KEY_ID / KF_ACCESS_KEY_SECRET (same admin key used to build the app)
npm start
```

Visit `http://localhost:3000/` — you should see `{"status":"ok",...}`. It'll start polling
immediately (every 60s by default) — submit a test Reconciliation Run in Kissflow and watch
the terminal output. It logs each step and any parsing warnings (unmatched bank rows,
missing terminal/store lookups) so you can see what happened.

## Hosting — deploying this so it's always reachable

Your own laptop can't run this, because Kissflow's servers need to reach it over the
internet, and `localhost` on your machine isn't reachable from outside your network. The
simplest fix: deploy this to **Render** (render.com) — free to start, no server to manage,
and it stays running without you doing anything after the first setup.

**Steps:**

1. **Put this folder in a Git repository.** If you don't already have one:
   ```bash
   cd /Users/harinisatish/Desktop/Demo/reconciliation-service
   git init
   git add .
   git commit -m "Initial reconciliation service"
   ```
   Then create an empty repository on GitHub (github.com → New repository) and push:
   ```bash
   git remote add origin <the URL GitHub gives you>
   git push -u origin main
   ```
   (`.env` is not tracked by git by default here — never commit it; you'll enter the
   credentials directly in Render's dashboard instead, in step 4.)

2. **Sign up at render.com** (free, no credit card needed for the free tier).

3. **New → Web Service → connect your GitHub repo** (Render will ask for one-time
   permission to see your repos — pick just this one if it offers a scoped option).

4. Render will detect this is a Node app. Set:
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Environment Variables**: add `KF_DOMAIN`, `KF_ACCOUNT_ID`, `KF_ACCESS_KEY_ID`,
     `KF_ACCESS_KEY_SECRET`, `KF_APP_ID` — same values as your `.env` file, entered directly
     in Render's dashboard (this is the secure way to hand it credentials; nothing goes into
     the git repo).

5. Click **Create Web Service**. Render builds and deploys it — you'll get a URL like
   `https://fmcg-reconciliation-service.onrender.com`.

6. Visit `https://<your-render-url>/` to confirm you see `{"status":"ok",...}` — that
   confirms it's live and reachable from the internet.

**Important free-tier quirk, specific to polling:** Render's free web services "sleep"
after 15 minutes with no *inbound* HTTP traffic. With a webhook-driven design that's
harmless (the incoming call wakes it up) — but this service works by *polling outward* on
its own schedule, so once it falls asleep, nothing will ever hit it to wake it back up
again. The poll loop would just silently stop, and Reconciliation Runs would sit at
"Processing" forever with nobody noticing.

**Fix (still free): use a free uptime-monitor to ping the health check.** Sign up at
**UptimeRobot** (uptimerobot.com, free tier) or **cron-job.org** (also free), and add a
monitor that hits `https://<your-render-url>/` every 5 minutes. That inbound ping is enough
to keep Render from ever putting the service to sleep, so the poll loop keeps running
continuously. This is a standard, well-known pairing for exactly this situation (a
background job on a free web-service tier) — five minutes of setup, no cost.

If you'd rather not rely on an external pinger, Render's paid tier ($7/month) removes the
sleep behavior entirely — worth it once this is something the business actually depends on
daily, but not required to get started.

## No Kissflow-side wiring needed

Because this polls Kissflow itself rather than waiting for a webhook, there's nothing to
configure on the Reconciliation Run process's Start step — deploying this service (with the
uptime pinger above) is the whole setup. It'll pick up the very next Reconciliation Run
Finance submits, within one poll interval.

## Throughput

Writing back is one record at a time — a real month (~8,000 Reconciliation Line +
Terminal Settlement Detail rows for an 80-store chain) takes on the order of a day at
observed throughput (~3-5 records/min). This isn't a hosting-tier limitation: Kissflow's
Form API has no bulk-create endpoint (checked directly — `/bulk`, `/bulk-create`, and a
raw array body all 404 or fail validation), and each record is inherently two sequential
HTTP calls (see `kf.createFormItem`'s doc comment for why). Concurrency does not help
either — see `createFormItem`'s doc comment on why calls are serialized process-wide.
`runReconciliation` is resumable (see `loadExistingRunLines`/`loadExistingDetailKeys`), so
a multi-hour run surviving a restart or redeploy partway through is expected and safe —
it picks up where it left off rather than duplicating or losing work.

## One run at a time

`pollOnce()` processes pending runs sequentially within a single tick, and `setInterval`
never starts a new tick while one is still in flight (see the `polling` flag). This means
a long-running run — a real month, or an accidentally-oversized test — fully blocks every
other pending run behind it, including ones submitted after it. There's no way to cancel
an in-flight run's own execution short of killing the process (a redeploy, which resumability
makes safe); simply changing the stuck run's own Status field has no effect, since the
already-running loop holds its own copy of the run in memory and never re-checks it.
