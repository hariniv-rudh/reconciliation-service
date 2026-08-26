// Parses the monthly Sales Report workbook: one tab per store, rows = payment type,
// columns = day of month (1..31) + a TOTAL column. Only the 4 card-network rows matter
// here; everything else (cash, vouchers, discounts, adjustments) is out of scope.
//
// Store identity: the tab name is expected as "<storeId>-<storeCode>" (e.g. "13194-AAB"),
// matching the real workbooks this was built against. Adjust STORE_TAB_PATTERN if your
// actual file uses a different convention.
//
// Skips known non-store tabs (Total/Summary/variance/Cash Sale/SheetN/etc.) automatically —
// any tab whose name doesn't match the store-tab pattern is ignored.

import xlsx from "xlsx";

const STORE_TAB_PATTERN = /^(\d+)\s*-\s*(.+)$/;
const NETWORK_ROW_LABELS = {
  "SPAN CARDS": "SPAN",
  "VISA CARDS": "VISA",
  "AMEX CARDS": "AMEX",
  "MASTER CARDS": "MASTER",
};

/**
 * @param {Buffer} fileBuffer
 * @param {Map<string,string>} storeIdByCode - maps the workbook's own store id (e.g. "13194") to the real Kissflow Store record id, if they differ. Pass an empty Map to use the workbook's id verbatim.
 * @returns {Array<{storeId:string, network:string, day:number, amount:number}>}
 */
export function parseSalesReport(fileBuffer, storeIdByCode = new Map()) {
  const wb = xlsx.read(fileBuffer, { type: "buffer" });
  const out = [];

  for (const sheetName of wb.SheetNames) {
    const m = sheetName.match(STORE_TAB_PATTERN);
    if (!m) continue; // not a store tab (Total/Summary/variance/Cash Sale/SheetN/etc.)
    const rawStoreId = m[1].trim();
    const storeId = storeIdByCode.get(rawStoreId) || rawStoreId;

    const sheet = wb.Sheets[sheetName];
    const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null });

    // Day-of-month header row: the first row whose cells are mostly small sequential integers.
    let dayRowIdx = -1;
    for (let r = 0; r < Math.min(rows.length, 10); r++) {
      const row = rows[r] || [];
      const nums = row.filter((c) => typeof c === "number" && c >= 1 && c <= 31);
      if (nums.length >= 5) { dayRowIdx = r; break; }
    }
    if (dayRowIdx < 0) { console.warn(`parseSalesReport: no day header found on tab "${sheetName}" — skipped`); continue; }
    const dayRow = rows[dayRowIdx];

    for (let r = dayRowIdx + 1; r < rows.length; r++) {
      const row = rows[r];
      if (!row || !row[0]) continue;
      const label = String(row[0]).trim().toUpperCase();
      const network = NETWORK_ROW_LABELS[label];
      if (!network) continue;

      for (let c = 1; c < row.length; c++) {
        const day = dayRow[c];
        if (typeof day !== "number" || day < 1 || day > 31) continue;
        const amount = Number(row[c]);
        if (Number.isNaN(amount)) continue;
        out.push({ storeId, network, day, amount });
      }
    }
  }

  return out;
}
