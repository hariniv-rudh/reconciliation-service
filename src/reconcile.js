// Core matching engine. Pure functions where possible (easy to unit-test against a
// real sample file without hitting Kissflow) — the only I/O-touching function here
// is runReconciliation(), which orchestrates everything and writes results back.

import { parseBankStatement } from "./parseBankStatement.js";
import { parseSalesReport } from "./parseSalesReport.js";
import * as kf from "./kissflow.js";

const TOLERANCE = 0.01;

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}
function isoDate(date) {
  return date.toISOString().slice(0, 10);
}
function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate(); // day 0 of next month = last day of this one
}

/**
 * Run `worker(item)` over `items` with at most `limit` in flight concurrently. Plain
 * async/await concurrency — JS is single-threaded, so two workers never actually execute
 * at the same instant; they just interleave at each other's `await` points, which is enough
 * to keep many HTTP round-trips in flight at once without any locking around shared state,
 * as long as no worker's own read-modify-write of a piece of state spans an await that
 * another worker could also touch (see call sites for why that's true here).
 */
async function runWithConcurrency(items, limit, worker) {
  let idx = 0;
  async function run() {
    while (idx < items.length) await worker(items[idx++]);
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

/**
 * Match bank statement lines to sales-report lines at STORE + NETWORK + DAY grain,
 * applying the T+1 lag (a sale on day N settles on the bank statement dated N+1),
 * and only using PRINCIPAL SETTLEMENT bank lines (fees/VAT excluded).
 *
 * @param {Array} bankLines - from parseBankStatement()
 * @param {Array} salesLines - from parseSalesReport(), each {storeId, network, day, amount}
 * @param {number} year, month - the reconciliation period (month is 1-based)
 * @param {Map<string,string>} storeIdByTerminal - Terminal ID -> Store ID (from Terminal Master)
 * @returns {{lines: Array, terminalDetail: Array}}
 *   lines: one per store+network+day found in EITHER dataset, with glAmount/bankAmount/date
 *   terminalDetail: one per terminal that contributed a matched bank amount, for drill-down
 */
export function matchStoreNetworkDay(bankLines, salesLines, year, month, storeIdByTerminal) {
  const principal = bankLines.filter((l) => l.lineType === "Principal Settlement");

  // Bucket principal bank lines by [storeId, network, saleDay] — the sale day is the
  // bank line's own date MINUS 1 (T+1 lag inverted back to the sale-side day).
  const bankBucket = new Map(); // key -> { total, byTerminal: Map<terminalId, amount> }
  const bankKey = (storeId, network, day) => `${storeId}|${network}|${day}`;

  for (const line of principal) {
    const storeId = storeIdByTerminal.get(line.terminalId);
    if (!storeId) { console.warn(`No store found for terminal ${line.terminalId} (bank line, ${line.description.slice(0, 40)})`); continue; }
    if (line.network === "AMEX") continue; // AMEX is manual-only, never auto-matched
    const saleDate = addDays(line.date, -1);
    if (saleDate.getUTCFullYear() !== year || saleDate.getUTCMonth() + 1 !== month) continue; // outside this run's period
    const day = saleDate.getUTCDate();
    const key = bankKey(storeId, line.network, day);
    if (!bankBucket.has(key)) bankBucket.set(key, { total: 0, byTerminal: new Map() });
    const bucket = bankBucket.get(key);
    bucket.total += line.amount;
    bucket.byTerminal.set(line.terminalId, (bucket.byTerminal.get(line.terminalId) || 0) + line.amount);
  }

  // The Sales Report workbook always has day columns 1..31 regardless of the real month
  // length (a fixed template) — a short month's unused trailing columns must be dropped
  // here, not passed through, or `new Date(Date.UTC(year, month-1, day))` silently rolls
  // a day like 30 in February into March 2nd (JS Date normalizes rather than throwing),
  // corrupting the output date. Verified live, 2026-08-27: a real Feb run's sales tabs
  // carried day values up to 31.
  const lastDay = daysInMonth(year, month);
  const validSalesLines = [];
  let droppedOutOfRangeDays = 0, droppedOutOfRangeAmount = 0;
  for (const s of salesLines) {
    if (s.day > lastDay) {
      if (s.amount) { droppedOutOfRangeDays++; droppedOutOfRangeAmount += s.amount; }
      continue;
    }
    validSalesLines.push(s);
  }
  if (droppedOutOfRangeDays) {
    console.warn(`matchStoreNetworkDay: dropped ${droppedOutOfRangeDays} sales row(s) on out-of-range day-of-month (> ${lastDay} for ${year}-${month}) carrying a nonzero total of ${droppedOutOfRangeAmount} — check the Sales Report template's unused trailing day columns`);
  }

  const salesBucket = new Map(); // key -> amount
  for (const s of validSalesLines) salesBucket.set(bankKey(s.storeId, s.network, s.day), (salesBucket.get(bankKey(s.storeId, s.network, s.day)) || 0) + s.amount);

  const allKeys = new Set([...bankBucket.keys(), ...salesBucket.keys()]);
  const lines = [];
  const terminalDetail = [];

  for (const key of allKeys) {
    const [storeId, network, dayStr] = key.split("|");
    const day = Number(dayStr);
    const glAmount = salesBucket.get(key) || 0;
    const bankAmount = bankBucket.get(key)?.total || 0;
    const date = new Date(Date.UTC(year, month - 1, day));
    lines.push({ storeId, network, date, glAmount, bankAmount });

    const byTerminal = bankBucket.get(key)?.byTerminal;
    if (byTerminal) {
      for (const [terminalId, amount] of byTerminal) {
        terminalDetail.push({ storeId, network, date, terminalId, matchedBankAmount: amount });
      }
    }
  }

  // AMEX: GL exists but Bank Amount is always left for manual entry (no terminal ref on the bank side).
  for (const s of validSalesLines) {
    if (s.network !== "AMEX") continue;
    const key = bankKey(s.storeId, s.network, s.day);
    if (lines.some((l) => l.storeId === s.storeId && l.network === "AMEX" && l.date.getUTCDate() === s.day)) continue;
    lines.push({ storeId: s.storeId, network: "AMEX", date: new Date(Date.UTC(year, month - 1, s.day)), glAmount: s.amount, bankAmount: null });
  }

  return { lines, terminalDetail };
}

/**
 * Resumability: fetch every Reconciliation_Line already written for THIS SPECIFIC run, so a
 * retry after a crash (which WILL happen at this call volume — see kissflow.js's retry
 * comment) skips re-creating what a previous attempt already wrote instead of duplicating
 * it or requiring a manual purge. Verified necessary live, 2026-08-27: three separate
 * crashes (a real bug, a real bug, then a transient Kissflow 502) each discarded an
 * in-progress run's work with no way to continue, forcing a manual reset-then-cleanup cycle
 * each time. Keyed the same way as `lines` themselves (store+network+day) so a resumed run
 * can look each one up directly.
 */
async function loadExistingRunLines(runId) {
  const res = await kf.listItems("Reconciliation_Line_A00", { pageSize: 5000 });
  const items = res?.Data || [];
  const byKey = new Map(); // "storeId|network|day" -> lineId
  for (const item of items) {
    if ((item.reconciliation_run?._id || item.reconciliation_run) !== runId) continue;
    const storeId = item.store?._id || item.store;
    const day = new Date(item.date).getUTCDate();
    byKey.set(`${storeId}|${item.network}|${day}`, item._id || item.id);
  }
  return byKey;
}

/** Same idea as loadExistingRunLines, for the Terminal_Settlement_Detail side. */
async function loadExistingDetailKeys(lineIds) {
  const res = await kf.listItems("Terminal_Settlement_Detail_A00", { pageSize: 5000 });
  const items = res?.Data || [];
  const keys = new Set(); // "lineId|terminalId"
  for (const item of items) {
    const lineId = item.reconciliation_line?._id || item.reconciliation_line;
    if (!lineIds.has(lineId)) continue;
    const terminalId = item.terminal?.terminal_id;
    if (terminalId) keys.add(`${lineId}|${terminalId}`);
  }
  return keys;
}

/**
 * Build the starting carry-forward state — one {balance, lineId} per STORE+NETWORK —
 * from every existing Reconciliation Line, keeping only each key's most recent (by date).
 *
 * Deliberately does NOT use Kissflow's server-side `Filter` — verified live, 2026-08-27,
 * that a capitalized `Filter` body (the only variant the server doesn't silently ignore)
 * 500s regardless of shape tried (object filter, array-of-conditions), even on a trivial
 * single-field Boolean filter on an unrelated form — while lowercase `filter`/`criteria`
 * keys are accepted but silently no-op (confirmed by comparing result counts). Rather than
 * keep guessing an undocumented query DSL, this fetches the whole table sorted by date
 * (`sortBy` IS honored, confirmed working) and reduces client-side — the same robust
 * pattern already used for Terminal/Store Master and the run-polling logic. Revisit if
 * the ledger grows large enough that this full-table fetch becomes a real cost.
 */
async function loadCarryForwardState() {
  const res = await kf.listItems("Reconciliation_Line_A00", { sortBy: "-date", pageSize: 5000 });
  const items = res?.Data || [];
  const state = new Map(); // "storeId|network" -> {balance, lineId}
  for (const item of items) {
    const storeId = item.store?._id || item.store;
    const key = `${storeId}|${item.network}`;
    if (state.has(key)) continue; // already saw this key's most recent (list is date-desc)
    state.set(key, { balance: item.closing_carry_forward_balance ?? 0, lineId: item._id || item.id });
  }
  return state;
}

/**
 * Full pipeline for one Reconciliation Run: parse both files, match, write everything
 * back to Kissflow, and set the run's Status to Reconciled or Failed.
 *
 * @param {object} ctx
 * @param {string} ctx.runId - the Reconciliation_Run_A00 item id
 * @param {Buffer} ctx.bankStatementBuffer
 * @param {Buffer} ctx.salesReportBuffer
 * @param {object} ctx.bankMaster - the run's Bank Master record fields
 * @param {Array} ctx.codeMap - Bank Statement Code Mapping rows for that bank
 * @param {Array<{id:string, terminal_id:string, store:string}>} ctx.terminals - full Terminal Master export
 * @param {Array<{id:string, store_id:string}>} ctx.stores - full Store Master export (id = Kissflow record id, store_id = the workbook's own store code)
 * @param {number} ctx.year
 * @param {number} ctx.month
 */
export async function runReconciliation(ctx) {
  const { runId, bankStatementBuffer, salesReportBuffer, bankMaster, codeMap, terminals, stores, year, month } = ctx;

  // A Form list item's own id is always `_id`, never `id` — and a Reference field's value
  // (Terminal Master's `store`) comes back as a nested `{_id, Name, ...}` object, not a bare
  // string, the same as everywhere else in this app. Both were wrong here (using `.id` and
  // trusting `t.store` was already a string) — verified live, 2026-08-27, after a real run
  // crashed with a literal "[object Object]" id: `kf.ref(t.store)` had wrapped the whole
  // nested object a second time, producing `{_id: {_id, Name, store_name}}`.
  const storeIdByTerminal = new Map(terminals.map((t) => [t.terminal_id, t.store?._id || t.store])); // terminal id text -> Kissflow Store record id
  const terminalRecordIdByTerminalId = new Map(terminals.map((t) => [t.terminal_id, t._id || t.id])); // terminal id text -> Kissflow Terminal record id
  const storeRecordByCode = new Map(stores.map((s) => [s.store_id, s._id || s.id])); // workbook store code -> Kissflow Store record id

  const { lines: bankLines, unmatched } = parseBankStatement(bankStatementBuffer, bankMaster, codeMap);
  const salesLinesRaw = parseSalesReport(salesReportBuffer);

  // Only keep sales rows for a store we actually have a Store Master record for. A silent
  // `|| s.storeId` fallback here (kept the raw workbook code, e.g. "13205") would flow a
  // non-existent id all the way into `kf.ref(...)` and 404 the very first time one of these
  // is written — Kissflow validates a Reference field against the real Store Master table.
  // Verified live, 2026-08-27: the real Sales Report workbook has tabs for 127 distinct
  // stores, but the Terminal-to-Store master workbook this app's Store Master was imported
  // from only covers 80 — a genuine gap in the customer's own master data (47 stores have
  // sales but no terminal/store record at all, so no bank data could ever match them
  // either). These are skipped and reported rather than written as fabricated discrepancy
  // lines; the fix belongs in the customer's master data, not the code.
  const unmappedStoreTotals = new Map(); // raw workbook store code -> total amount skipped
  const salesLines = [];
  for (const s of salesLinesRaw) {
    const mapped = storeRecordByCode.get(s.storeId);
    if (!mapped) {
      unmappedStoreTotals.set(s.storeId, (unmappedStoreTotals.get(s.storeId) || 0) + s.amount);
      continue;
    }
    salesLines.push({ ...s, storeId: mapped });
  }
  if (unmappedStoreTotals.size) {
    console.warn(`runReconciliation: ${unmappedStoreTotals.size} store(s) in the Sales Report have no Store Master record — skipped, sales data ignored for: ${[...unmappedStoreTotals.entries()].map(([id, total]) => `${id} (${total})`).join(", ")}`);
  }

  const { lines, terminalDetail } = matchStoreNetworkDay(bankLines, salesLines, year, month, storeIdByTerminal);

  // Sort chronologically so carry-forward chains correctly within this run.
  lines.sort((a, b) => a.date - b.date);

  const createdLineIds = new Map(); // "storeId|network|day" -> Reconciliation_Line item id
  const carryForward = await loadCarryForwardState(); // "storeId|network" -> {balance, lineId}
  const existingRunLines = await loadExistingRunLines(runId); // resumability — see its own doc comment
  let flaggedCount = 0, matchedCount = 0, resumedLineCount = 0;

  // Group into independent carry-forward chains, one per store+network. Each chain's own
  // lines MUST stay strictly sequential (every line's opening balance is the previous
  // line's closing balance in that SAME chain) — but different chains never depend on each
  // other, so many chains can run concurrently for real throughput at this record volume.
  // A single fully-sequential loop over ~8,000 records (2 HTTP round-trips each) was
  // measured live, 2026-08-27, on a real run: ~3 records/min — the better part of two days
  // for one month's reconciliation. Concurrency is across CHAINS, not within one, so
  // ordering/correctness inside each chain is unaffected.
  //
  // CHAIN_CONCURRENCY=8 made things WORSE, not better, on Render's free tier — verified
  // live: only 8 net-new records in 5+ minutes (vs ~15 expected from the sequential
  // baseline), plus the health endpoint itself taking 42s to respond. Kissflow's own API
  // handled 8 concurrent requests fine from a normal connection (verified directly), so this
  // isn't Kissflow throttling us — it's the free tier's ~0.1 shared vCPU thrashing between
  // many simultaneous TLS handshakes instead of completing requests quickly one at a time.
  // Dialed down to a conservative 3 as a middle ground; revisit (up or down) based on
  // observed throughput, and prefer a real vCPU (paid tier) over tuning this further if it's
  // still not enough.
  const CHAIN_CONCURRENCY = 3;
  const chains = new Map(); // "storeId|network" -> ordered array of lines (already date-sorted)
  for (const line of lines) {
    const cfKey = `${line.storeId}|${line.network}`;
    if (!chains.has(cfKey)) chains.set(cfKey, []);
    chains.get(cfKey).push(line);
  }

  await runWithConcurrency([...chains.entries()], CHAIN_CONCURRENCY, async ([cfKey, chainLines]) => {
    for (const line of chainLines) {
      const bankAmount = line.bankAmount; // null for AMEX = leave blank for manual entry
      const diff = bankAmount == null ? null : line.glAmount - bankAmount;
      const flagged = diff != null && Math.abs(diff) > TOLERANCE;

      const dayKey = `${line.storeId}|${line.network}|${line.date.getUTCDate()}`;
      const prev = carryForward.get(cfKey);
      const openingBalance = prev?.balance ?? 0;

      let lineId = existingRunLines.get(dayKey);
      if (lineId) {
        resumedLineCount++;
      } else {
        const fields = {
          reconciliation_run: kf.ref(runId),
          store: kf.ref(line.storeId),
          network: line.network,
          date: isoDate(line.date),
          gl_amount: line.glAmount,
          bank_amount: bankAmount ?? undefined, // omit for AMEX rather than send null, if the API rejects null on a required-ish currency field
          opening_balance: openingBalance,
          previous_line: kf.ref(prev?.lineId),
          status: bankAmount == null ? "Under Review" : flagged ? "Flagged" : "Matched", // AMEX always needs a human to fill in the bank side
        };
        const created = await kf.createFormItem("Reconciliation_Line_A00", fields);
        lineId = created._id || created.id;
      }
      createdLineIds.set(dayKey, lineId);

      // Advance this chain's running balance for the NEXT line in the SAME chain — the
      // closing balance at creation time is always opening+diff, since Amount
      // Claimed/Excess are only ever set later, by the (manually-configured) Discrepancy
      // Review automations. Left untouched for AMEX (diff is null — nothing measurable to
      // carry forward yet). Recomputed the same way whether this line is new or resumed
      // from a prior attempt — parsing/matching is deterministic, so it reproduces the same
      // diff either way, keeping the chain correct without needing to trust a
      // previously-written row's own field value. Safe under concurrency: only this
      // chain's own worker ever reads or writes this cfKey.
      if (diff != null) carryForward.set(cfKey, { balance: openingBalance + diff, lineId });

      if (flagged) flaggedCount++; else if (bankAmount != null) matchedCount++;
    }
  });
  if (resumedLineCount) console.log(`runReconciliation: resumed ${resumedLineCount} Reconciliation_Line row(s) already written by a previous attempt at this run`);

  // Terminal_Settlement_Detail rows have no ordering dependency on each other at all (unlike
  // the Reconciliation_Line chains above), so they can all just go in one flat concurrent pool.
  // Same free-tier CPU ceiling as CHAIN_CONCURRENCY above applies here too.
  const DETAIL_CONCURRENCY = 3;
  const existingDetailKeys = await loadExistingDetailKeys(new Set(createdLineIds.values()));
  let resumedDetailCount = 0;
  await runWithConcurrency(terminalDetail, DETAIL_CONCURRENCY, async (t) => {
    const lineId = createdLineIds.get(`${t.storeId}|${t.network}|${t.date.getUTCDate()}`);
    if (!lineId) return;
    const terminalRecordId = terminalRecordIdByTerminalId.get(t.terminalId);
    if (!terminalRecordId) { console.warn(`No Terminal Master record found for terminal id "${t.terminalId}" — skipping its settlement-detail row`); return; }
    if (existingDetailKeys.has(`${lineId}|${t.terminalId}`)) { resumedDetailCount++; return; }
    await kf.createFormItem("Terminal_Settlement_Detail_A00", {
      reconciliation_line: kf.ref(lineId),
      terminal: kf.ref(terminalRecordId),
      matched_bank_amount: t.matchedBankAmount,
      store: kf.ref(t.storeId),
      network: t.network,
      date: isoDate(t.date),
    });
  });
  if (resumedDetailCount) console.log(`runReconciliation: resumed ${resumedDetailCount} Terminal_Settlement_Detail row(s) already written by a previous attempt at this run`);

  await kf.updateProcessItem("Reconciliation_Run_A00", runId, { status: "Reconciled" });

  return {
    linesCreated: lines.length,
    flaggedCount,
    matchedCount,
    unmatchedBankRows: unmatched.length,
    storesSkippedNoMasterRecord: unmappedStoreTotals.size,
  };
}
