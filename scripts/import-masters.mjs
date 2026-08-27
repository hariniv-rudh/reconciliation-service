// One-off bulk import: real Store Master + Terminal Master records from Workbook1.xlsx,
// into the live Kissflow app. Run once (or safely re-run — it skips stores/terminals that
// already exist by matching on their own business key, not just record count).
//
// Usage: KF_DOMAIN=... KF_ACCOUNT_ID=... KF_ACCESS_KEY_ID=... KF_ACCESS_KEY_SECRET=... \
//   node scripts/import-masters.mjs /path/to/Workbook1.xlsx

import xlsx from "xlsx";
import { readFileSync } from "node:fs";
import * as kf from "../src/kissflow.js";

const filePath = process.argv[2];
if (!filePath) { console.error("usage: node import-masters.mjs <Workbook1.xlsx path>"); process.exit(1); }

const wb = xlsx.read(readFileSync(filePath), { type: "buffer" });
const sheet = wb.Sheets[wb.SheetNames[0]];
const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: null });

const storeNameById = new Map(); // store_id -> store_name
const terminalRows = []; // {terminalId, storeId}
for (let r = 3; r < rows.length; r++) {
  const row = rows[r];
  const terminalId = row[1], storeName = row[2], storeId = row[3];
  if (!terminalId || !storeId) continue;
  storeNameById.set(String(storeId), storeName);
  terminalRows.push({ terminalId: String(terminalId), storeId: String(storeId) });
}
console.log(`Parsed ${storeNameById.size} distinct stores, ${terminalRows.length} terminal rows.`);

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// --- Store Master -----------------------------------------------------------
console.log("\nChecking existing Store Master records...");
const existingStoresRes = await kf.listItems("FMCG_Store_Master_A00", { pageSize: 1000 });
const existingStores = existingStoresRes?.Data || [];
const storeRecordIdByCode = new Map(existingStores.map((s) => [s.store_id, s._id]));
console.log(`${existingStores.length} Store Master record(s) already exist.`);

let storesCreated = 0;
for (const [storeId, storeName] of storeNameById) {
  if (storeRecordIdByCode.has(storeId)) continue;
  const created = await kf.createFormItem("FMCG_Store_Master_A00", { store_id: storeId, store_name: storeName, active: true });
  storeRecordIdByCode.set(storeId, created._id || created.id);
  storesCreated++;
  if (storesCreated % 20 === 0) { console.log(`  ...${storesCreated} stores created`); await sleep(200); }
}
console.log(`Store Master: ${storesCreated} created, ${storeNameById.size - storesCreated} already existed.`);

// --- Terminal Master ----------------------------------------------------------
console.log("\nChecking existing Terminal Master records...");
const existingTerminalsRes = await kf.listItems("FMCG_Terminal_Master_A00", { pageSize: 1000 });
const existingTerminals = existingTerminalsRes?.Data || [];
const existingTerminalIds = new Set(existingTerminals.map((t) => t.terminal_id));
console.log(`${existingTerminals.length} Terminal Master record(s) already exist.`);

let terminalsCreated = 0, terminalsSkippedNoStore = 0;
for (const { terminalId, storeId } of terminalRows) {
  if (existingTerminalIds.has(terminalId)) continue;
  const storeRecordId = storeRecordIdByCode.get(storeId);
  if (!storeRecordId) { console.warn(`  no Store Master record for store id ${storeId} — skipping terminal ${terminalId}`); terminalsSkippedNoStore++; continue; }
  await kf.createFormItem("FMCG_Terminal_Master_A00", { terminal_id: terminalId, store: kf.ref(storeRecordId), active: true });
  existingTerminalIds.add(terminalId);
  terminalsCreated++;
  if (terminalsCreated % 20 === 0) { console.log(`  ...${terminalsCreated} terminals created`); await sleep(200); }
}
console.log(`Terminal Master: ${terminalsCreated} created, ${terminalsSkippedNoStore} skipped (no store), ${terminalRows.length - terminalsCreated - terminalsSkippedNoStore} already existed.`);

console.log("\nDone.");
