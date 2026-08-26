// Thin Kissflow REST client. All calls use the account's admin access key (same
// credentials as the Kissflow app build itself — set these as environment variables
// on whatever host you deploy this to; never commit them to source control).

const DOMAIN = process.env.KF_DOMAIN;
const ACCOUNT_ID = process.env.KF_ACCOUNT_ID;
const ACCESS_KEY_ID = process.env.KF_ACCESS_KEY_ID;
const ACCESS_KEY_SECRET = process.env.KF_ACCESS_KEY_SECRET;
const APP_ID = process.env.KF_APP_ID || "FMCG_POS_Bank_Reconciliation_A00";

if (!DOMAIN || !ACCOUNT_ID || !ACCESS_KEY_ID || !ACCESS_KEY_SECRET) {
  throw new Error("Missing KF_DOMAIN / KF_ACCOUNT_ID / KF_ACCESS_KEY_ID / KF_ACCESS_KEY_SECRET env vars");
}

const BASE = `https://${DOMAIN}`;
const headers = {
  "X-Access-Key-Id": ACCESS_KEY_ID,
  "X-Access-Key-Secret": ACCESS_KEY_SECRET,
  "Content-Type": "application/json",
};

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (res.status >= 300) {
    throw new Error(`Kissflow ${method} ${path} -> ${res.status}: ${JSON.stringify(json).slice(0, 500)}`);
  }
  return json;
}

// --- Form CRUD -------------------------------------------------------------

/** Create one item in a Form-type flow. `fields` is {fieldId: value}. */
export async function createFormItem(flowId, fields) {
  return call("POST", `/form/2/${ACCOUNT_ID}/${flowId}?_application_id=${APP_ID}`, fields);
}

/** Create one item in a Process flow (raises it at the Start step). */
export async function createProcessItem(flowId, fields) {
  return call("POST", `/process/2/${ACCOUNT_ID}/${flowId}?_application_id=${APP_ID}`, fields);
}

/** Update one item in a Form-type flow. */
export async function updateFormItem(flowId, itemId, fields) {
  return call("PATCH", `/form/2/${ACCOUNT_ID}/${flowId}/${itemId}?_application_id=${APP_ID}`, fields);
}

/** Update one item in a Process flow (its own business fields, not the step). */
export async function updateProcessItem(flowId, itemId, fields) {
  return call("PATCH", `/process/2/${ACCOUNT_ID}/${flowId}/${itemId}?_application_id=${APP_ID}`, fields);
}

/** List items in a flow, with optional filter/sort. See Kissflow REST docs for filter shape. */
export async function listItems(flowId, { filter, sortBy, pageSize = 100, family = "form" } = {}) {
  const q = new URLSearchParams({ _application_id: APP_ID, _response_type: "full", pageSize: String(pageSize) });
  if (sortBy) q.set("sortBy", sortBy);
  const body = filter ? { Filter: filter } : {};
  return call("POST", `/${family}/2/${ACCOUNT_ID}/${flowId}/list?${q}`, body);
}

/** Fetch one item by id. */
export async function getItem(flowId, itemId, family = "form") {
  return call("GET", `/${family}/2/${ACCOUNT_ID}/${flowId}/${itemId}?_application_id=${APP_ID}`);
}

// --- File download -----------------------------------------------------------

/**
 * Download an uploaded attachment's bytes. `attachmentField` is the value Kissflow
 * returns for an Attachment field on a run item — typically an array of
 * {Name, Preview_URL/Download_URL, ...}. Adjust the property name below once you've
 * inspected a real payload (log it once from the webhook and check).
 */
export async function downloadAttachment(fileUrl) {
  const res = await fetch(fileUrl, { headers: { "X-Access-Key-Id": ACCESS_KEY_ID, "X-Access-Key-Secret": ACCESS_KEY_SECRET } });
  if (res.status >= 300) throw new Error(`download ${fileUrl} -> ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

export const ids = { ACCOUNT_ID, APP_ID };
