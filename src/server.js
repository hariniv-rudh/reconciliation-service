import express from "express";
import * as kf from "./kissflow.js";
import { runReconciliation } from "./reconcile.js";

// POLLING, not a webhook — this account has no HTTP/Webhook connector subscribed, so
// Kissflow can't push a "Reconcile was clicked" event to us. Instead, this service checks
// every POLL_INTERVAL_MS for any Reconciliation Run that's been submitted but not yet
// picked up, and processes it itself. Slightly less instant than a push (up to one poll
// interval of delay), but needs zero Kissflow-side wiring beyond the app itself.
//
// "Not yet picked up" = the run's own Status field has no value yet. The Start step's
// Status field is ReadOnly to Finance (they can't set it), and has no default, so a
// freshly-submitted run's Status is genuinely blank until this service claims it — the
// very first thing processRun() does is set it to "Processing", which is also what stops
// two poll ticks from grabbing the same run if one run takes longer than the interval.

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS) || 60_000;
const PORT = process.env.PORT || 3000;

const app = express();
app.get("/", (req, res) => res.json({ status: "ok", service: "fmcg-reconciliation-service", pollIntervalMs: POLL_INTERVAL_MS }));
app.listen(PORT, () => console.log(`fmcg-reconciliation-service listening on :${PORT} (health check only — no webhook endpoint)`));

let polling = false;

async function pollOnce() {
  if (polling) { console.log("poll: previous cycle still running, skipping this tick"); return; }
  polling = true;
  try {
    // TODO verify with real data: confirm this actually returns recent/all runs and that
    // `status` reads back as undefined/null/"" (not some other falsy shape) for an
    // unprocessed run — log one real item once to check before relying on this in
    // production. pageSize is generous since this fetches ALL runs and filters here in
    // JS rather than trusting an unverified server-side filter syntax.
    const res = await kf.listItems("Reconciliation_Run_A00", { family: "process", pageSize: 200 });
    const runs = res?.Data || res || [];
    const pending = runs.filter((r) => !r.status);

    if (pending.length) console.log(`poll: found ${pending.length} run(s) awaiting reconciliation`);
    for (const run of pending) {
      const runId = run._id || run.id;
      // Claim it immediately so a slower-than-expected run doesn't get double-picked-up
      // by the next tick.
      await kf.updateProcessItem("Reconciliation_Run_A00", runId, { status: "Processing" });
      try {
        await processRun(runId, run);
      } catch (err) {
        console.error(`Reconciliation Run ${runId} failed:`, err);
        await kf.updateProcessItem("Reconciliation_Run_A00", runId, { status: "Failed" }).catch((e) => console.error("Also failed to mark run as Failed:", e));
      }
    }
  } catch (err) {
    console.error("poll cycle failed:", err);
  } finally {
    polling = false;
  }
}

async function processRun(runId, run) {
  const bankMaster = await kf.getItem("FMCG_Bank_Master_A00", run.bank);
  const codeMap = bankMaster.bank_statement_code_mapping || []; // TODO: confirm the real child-table property name on a live Bank Master payload

  const bankStatementUrl = run.bank_statement_file?.[0]?.Preview_URL || run.bank_statement_file?.[0]?.url;
  const salesReportUrl = run.sales_report_file?.[0]?.Preview_URL || run.sales_report_file?.[0]?.url;
  if (!bankStatementUrl || !salesReportUrl) throw new Error("Run is missing one or both uploaded files");

  const [bankStatementBuffer, salesReportBuffer] = await Promise.all([
    kf.downloadAttachment(bankStatementUrl),
    kf.downloadAttachment(salesReportUrl),
  ]);

  const terminalsRes = await kf.listItems("FMCG_Terminal_Master_A00", { pageSize: 1000 });
  const terminals = terminalsRes?.Data || terminalsRes || [];
  const storesRes = await kf.listItems("FMCG_Store_Master_A00", { pageSize: 1000 });
  const stores = storesRes?.Data || storesRes || [];

  const periodStart = new Date(run.period_start_date);
  const result = await runReconciliation({
    runId,
    bankStatementBuffer,
    salesReportBuffer,
    bankMaster,
    codeMap,
    terminals,
    stores,
    year: periodStart.getUTCFullYear(),
    month: periodStart.getUTCMonth() + 1,
  });

  console.log(`Reconciliation Run ${runId} done:`, result);
}

console.log(`Polling every ${POLL_INTERVAL_MS / 1000}s for unprocessed Reconciliation Runs...`);
pollOnce();
setInterval(pollOnce, POLL_INTERVAL_MS);
