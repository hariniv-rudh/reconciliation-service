// Parses a raw bank statement Excel dump into structured lines, using a Bank Master
// record's configured extraction rule + code mapping table.
//
// PRIMARY strategy — word-scan: search the Transaction Description for any code from
// the Code Mapping table appearing as a whole word, and take the first 12+ digit run
// found anywhere in the text as the reference number (terminal id = its first N digits,
// per Bank Master's configured length). This is the primary strategy, not a fallback,
// because real Alinma statements were checked directly: the vast majority of principal
// settlement rows (SPANMRC/VISAMRC/BNETMRC — the ones that actually matter for
// reconciliation) arrive as verbose aggregate text like "SPANMRC اجمالي موازنة جهاز نقاط
// البيع رقم Value Date 6379947177562113 Reference لشبكة مدى..." — 23,474 of ~23,490
// principal rows in the real February sample were this verbose form; only 16 used the
// compact "<16-digit ref> <code>" layout. Positional slicing alone would have missed
// almost every principal settlement row.
//
// FALLBACK strategy — positional slice: if no known code is found anywhere in the
// description, fall back to Bank Master's configured start-position/length (useful for
// a future bank whose format has no distinguishing code word to search for at all).
//
// Uses `xlsx` (SheetJS) rather than a richer library because this needs to parse tens of
// thousands of rows fast — SheetJS's flat read is far faster than a full-object-model
// reader on files this size (verified: ExcelJS took minutes on a 71k-row file that xlsx
// parses in under a second). `xlsx`'s npm release has open advisories (prototype
// pollution / ReDoS) with no upstream fix, but those matter for a service parsing
// untrusted public uploads; this service only ever parses your own bank's statement
// export and Finance's own spreadsheet — files you already trust — so the risk doesn't
// apply here. Re-evaluate if this service ever needs to accept files from outside the
// organization.

import xlsx from "xlsx";

/**
 * Parse a "DD/MM/YYYY" transaction-date string the way this bank statement actually
 * writes it (confirmed live, 2026-08-31, against the real Transaction Date column —
 * bilingual header "تاريخ العملية / Transaction Date", values like "28/02/2026").
 *
 * `new Date(dateString)` was being used here directly, which — for an ambiguous
 * slash-separated string like this — assumes US-convention MM/DD/YYYY, not DD/MM/YYYY.
 * That silently corrupted every single date in the file two different ways: a day 1-12
 * (ambiguous either way) got its day and month SWAPPED (real "05/02/2026" = Feb 5th
 * parsed as May 2nd instead), while a day 13-31 (unambiguous — no 13th+ month exists)
 * produced Invalid Date and was silently dropped by the `Number.isNaN(date?.getTime())`
 * check below — never even counted as unmatched, just discarded. Together that meant
 * well over half of every month's real transactions were either on the wrong date in
 * the wrong month or missing outright. Explicit day/month/year parsing removes the
 * ambiguity entirely instead of depending on which convention `Date`'s string parser
 * happens to guess.
 */
function parseDdMmYyyy(s) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s.trim());
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  const day = Number(dd), month = Number(mm), year = Number(yyyy);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  // Guard against a rollover Date.UTC would otherwise accept silently (e.g. day=31 in a
  // 30-day month) — confirm the constructed date's own fields match what was asked for.
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date;
}

/**
 * @param {Buffer} fileBuffer - raw .xlsx bytes
 * @param {object} bankMaster - the Bank Master record's fields
 * @param {Array<{code:string, network:string, lineType:string}>} codeMap - Bank Statement Code Mapping child rows
 * @returns {{lines: Array, unmatched: Array}}
 */
export function parseBankStatement(fileBuffer, bankMaster, codeMap) {
  const wb = xlsx.read(fileBuffer, { type: "buffer", cellDates: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: null });

  const startPos = bankMaster.terminal_id_start_position;
  const tidLen = bankMaster.terminal_id_length;
  const catPos = bankMaster.category_code_start_position;
  const catLen = bankMaster.category_code_length;

  const codeByText = new Map(codeMap.map((c) => [c.code.trim().toUpperCase(), c]));
  // Longest code first, so "SFEEMRC TAX" is tried before the shorter "SFEEMRC" it contains.
  const codesLongestFirst = [...codeByText.keys()].sort((a, b) => b.length - a.length);

  // Bank statements carry a report letterhead/summary block before the real transaction
  // table — scan generously (not just the first ~10 rows) for the header row that names
  // Credit/Debit, Description, and Date (bilingual headers with embedded newlines are fine,
  // since this just checks substring containment).
  let headerRowIdx = -1, colAmount = -1, colDesc = -1, colDate = -1;
  for (let r = 0; r < Math.min(rows.length, 60); r++) {
    const row = rows[r] || [];
    const idx = (needle) => row.findIndex((c) => String(c || "").trim().toLowerCase().includes(needle));
    const a = idx("credit"), d = idx("description"), t = idx("date");
    if (a >= 0 && d >= 0 && t >= 0) { headerRowIdx = r; colAmount = a; colDesc = d; colDate = t; break; }
  }
  if (headerRowIdx < 0) throw new Error("Could not find header row with Credit/Debit, Description, and Date columns");

  const out = [];
  const unmatched = [];
  for (let r = headerRowIdx + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.every((c) => c == null || c === "")) continue;
    const amount = Number(row[colAmount]);
    const description = String(row[colDesc] || "").trim();
    const dateRaw = row[colDate];
    if (!description || Number.isNaN(amount)) continue;
    // dateRaw is text here ("DD/MM/YYYY", not a real Excel date cell — confirmed live) for
    // every real bank file checked so far, but fall back to trusting an actual Date object
    // (or ISO-ish string) if some other bank's export ever comes through with genuine
    // date-typed cells instead of formatted text.
    const date = dateRaw instanceof Date ? dateRaw : parseDdMmYyyy(String(dateRaw ?? "")) ?? new Date(dateRaw);
    if (Number.isNaN(date?.getTime())) continue;

    let terminalId = null, category = null, mapping = null;

    // PRIMARY: word-scan for a known code anywhere in the description.
    const foundCode = codesLongestFirst.find((code) => new RegExp(`\\b${code.replace(/\s+/g, "\\s+")}\\b`, "i").test(description));
    if (foundCode) {
      mapping = codeByText.get(foundCode);
      category = foundCode;
      const digits = description.match(/\d{10,}/);
      if (digits) terminalId = digits[0].substring(0, tidLen);
    }

    // FALLBACK: positional slice, for a description with no recognizable code word at all.
    if (!mapping) {
      const slicedTerminal = description.substring(startPos - 1, startPos - 1 + tidLen).trim();
      const slicedCategory = description.substring(catPos - 1, catPos - 1 + catLen).trim().toUpperCase();
      const slicedMapping = codeByText.get(slicedCategory);
      if (slicedMapping) { mapping = slicedMapping; category = slicedCategory; terminalId = slicedTerminal; }
    }

    if (!mapping || !terminalId) { unmatched.push({ row: r + 1, description }); continue; }

    out.push({
      amount, description, date,
      terminalId, category,
      network: mapping.network,
      lineType: mapping.lineType,
    });
  }

  if (unmatched.length) {
    console.warn(`parseBankStatement: ${unmatched.length} row(s) matched no known code — check Bank Master's code mapping.`, unmatched.slice(0, 10));
  }
  return { lines: out, unmatched };
}
