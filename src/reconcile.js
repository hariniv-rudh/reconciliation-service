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

  const salesBucket = new Map(); // key -> amount
  for (const s of salesLines) salesBucket.set(bankKey(s.storeId, s.network, s.day), (salesBucket.get(bankKey(s.storeId, s.network, s.day)) || 0) + s.amount);

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
  for (const s of salesLines) {
    if (s.network !== "AMEX") continue;
    const key = bankKey(s.storeId, s.network, s.day);
    if (lines.some((l) => l.storeId === s.storeId && l.network === "AMEX" && l.date.getUTCDate() === s.day)) continue;
    lines.push({ storeId: s.storeId, network: "AMEX", date: new Date(Date.UTC(year, month - 1, s.day)), glAmount: s.amount, bankAmount: null });
  }

  return { lines, terminalDetail };
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

  const storeIdByTerminal = new Map(terminals.map((t) => [t.terminal_id, t.store])); // terminal id text -> Kissflow Store record id
  const terminalRecordIdByTerminalId = new Map(terminals.map((t) => [t.terminal_id, t.id])); // terminal id text -> Kissflow Terminal record id
  const storeRecordByCode = new Map(stores.map((s) => [s.store_id, s.id])); // workbook store code -> Kissflow Store record id

  const { lines: bankLines, unmatched } = parseBankStatement(bankStatementBuffer, bankMaster, codeMap);
  const salesLinesRaw = parseSalesReport(salesReportBuffer);
  const salesLines = salesLinesRaw.map((s) => ({ ...s, storeId: storeRecordByCode.get(s.storeId) || s.storeId }));

  const { lines, terminalDetail } = matchStoreNetworkDay(bankLines, salesLines, year, month, storeIdByTerminal);

  // Sort chronologically so carry-forward chains correctly within this run.
  lines.sort((a, b) => a.date - b.date);

  const createdLineIds = new Map(); // "storeId|network|day" -> Reconciliation_Line item id
  const carryForward = await loadCarryForwardState(); // "storeId|network" -> {balance, lineId}
  let flaggedCount = 0, matchedCount = 0;

  for (const line of lines) {
    const bankAmount = line.bankAmount; // null for AMEX = leave blank for manual entry
    const diff = bankAmount == null ? null : line.glAmount - bankAmount;
    const flagged = diff != null && Math.abs(diff) > TOLERANCE;

    const cfKey = `${line.storeId}|${line.network}`;
    const prev = carryForward.get(cfKey);
    const openingBalance = prev?.balance ?? 0;

    const fields = {
      reconciliation_run: runId,
      store: line.storeId,
      network: line.network,
      date: isoDate(line.date),
      gl_amount: line.glAmount,
      bank_amount: bankAmount ?? undefined, // omit for AMEX rather than send null, if the API rejects null on a required-ish currency field
      opening_balance: openingBalance,
      previous_line: prev?.lineId || undefined,
      status: bankAmount == null ? "Under Review" : flagged ? "Flagged" : "Matched", // AMEX always needs a human to fill in the bank side
    };
    const created = await kf.createFormItem("Reconciliation_Line_A00", fields);
    const lineId = created._id || created.id;
    createdLineIds.set(`${line.storeId}|${line.network}|${line.date.getUTCDate()}`, lineId);

    // Advance this key's running balance for the NEXT line in this same run — the closing
    // balance at creation time is always opening+diff, since Amount Claimed/Excess are
    // only ever set later, by the (manually-configured) Discrepancy Review automations.
    // Left untouched for AMEX (diff is null — nothing measurable to carry forward yet).
    if (diff != null) carryForward.set(cfKey, { balance: openingBalance + diff, lineId });

    if (flagged) flaggedCount++; else if (bankAmount != null) matchedCount++;
  }

  for (const t of terminalDetail) {
    const lineId = createdLineIds.get(`${t.storeId}|${t.network}|${t.date.getUTCDate()}`);
    if (!lineId) continue;
    const terminalRecordId = terminalRecordIdByTerminalId.get(t.terminalId);
    if (!terminalRecordId) { console.warn(`No Terminal Master record found for terminal id "${t.terminalId}" — skipping its settlement-detail row`); continue; }
    await kf.createFormItem("Terminal_Settlement_Detail_A00", {
      reconciliation_line: lineId,
      terminal: terminalRecordId,
      matched_bank_amount: t.matchedBankAmount,
      store: t.storeId,
      network: t.network,
      date: isoDate(t.date),
    });
  }

  await kf.updateProcessItem("Reconciliation_Run_A00", runId, { status: "Reconciled" });

  return { linesCreated: lines.length, flaggedCount, matchedCount, unmatchedBankRows: unmatched.length };
}
