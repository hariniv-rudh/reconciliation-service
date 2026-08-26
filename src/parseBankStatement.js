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
    const date = dateRaw instanceof Date ? dateRaw : new Date(dateRaw);
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
